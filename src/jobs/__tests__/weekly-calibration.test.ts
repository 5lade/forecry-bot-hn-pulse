import { describe, expect, it } from "vitest";
import type { ItemsQueryClient } from "../../db/items.js";
import { decodePngHeader, PNG_SIGNATURE } from "../png.js";
import { InMemoryPlotStore } from "../plot-store.js";
import {
  brierScore,
  buildWeeklyCalibrationMessage,
  hitRateByBand,
  lastSevenDaysWindow,
  msUntilNextWeeklyUtc,
  plotKeyFor,
  plotUrlFor,
  renderCalibrationChart,
  rocAuc,
  runWeeklyCalibration,
  THRESHOLD_BANDS,
  WEEKLY_CAL_DAY_OF_WEEK,
  WEEKLY_CAL_HOUR_UTC,
  type WeeklyCalibrationDeps,
  type WeeklyCalibrationPrediction,
  type WeeklyCalibrationTelegramSender,
} from "../weekly-calibration.js";

interface FakeUserRow {
  id: string;
  telegram_user_id: number;
  tier: "free" | "pulse" | "pulse-pro" | "canceled";
  digest_opt_in: boolean;
}

interface FakePredictionRow {
  predicted_p: number;
  reached_front_page: boolean;
  first_seen_at: Date;
}

interface FakeDb {
  users: FakeUserRow[];
  predictions: FakePredictionRow[];
  runs: Set<string>;
  client: ItemsQueryClient;
  callLog: Array<{ text: string; params?: ReadonlyArray<unknown> }>;
}

function makeFakeDb(seed: {
  users?: FakeUserRow[];
  predictions?: FakePredictionRow[];
}): FakeDb {
  const users = [...(seed.users ?? [])];
  const predictions = [...(seed.predictions ?? [])];
  const runs = new Set<string>();
  const callLog: FakeDb["callLog"] = [];

  const client: ItemsQueryClient = {
    async query<T extends Record<string, unknown>>(
      text: string,
      params?: ReadonlyArray<unknown>,
    ): Promise<{ rows: T[] }> {
      callLog.push({ text, params });
      const sql = text.trim();

      if (
        /^SELECT[\s\S]*FROM users\b[\s\S]*tier\s*=\s*'pulse-pro'/i.test(sql)
      ) {
        const rows = users
          .filter((u) => u.digest_opt_in && u.tier === "pulse-pro")
          .map((u) => ({
            id: u.id,
            telegram_user_id: u.telegram_user_id,
          }));
        return { rows: rows as unknown as T[] };
      }

      if (/^WITH first_snap AS/i.test(sql)) {
        const fromUtc = params![0] as Date;
        const toUtc = params![1] as Date;
        const rows = predictions
          .filter(
            (p) =>
              p.first_seen_at.getTime() >= fromUtc.getTime() &&
              p.first_seen_at.getTime() < toUtc.getTime(),
          )
          .map((p) => ({
            predicted_p: p.predicted_p,
            reached_front_page: p.reached_front_page,
          }));
        return { rows: rows as unknown as T[] };
      }

      if (/^INSERT INTO weekly_calibration_runs/i.test(sql)) {
        const userId = String(params![0]);
        const weekKey = String(params![1]);
        const key = `${userId}|${weekKey}`;
        if (runs.has(key)) return { rows: [] };
        runs.add(key);
        return { rows: [{ user_id: userId } as unknown as T] };
      }

      throw new Error(`FakeDb: unhandled SQL: ${sql.slice(0, 80)}`);
    },
  };

  return { users, predictions, runs, client, callLog };
}

interface RecordedSend {
  chatId: number;
  text: string;
}

function makeTelegram(): {
  sender: WeeklyCalibrationTelegramSender;
  sent: RecordedSend[];
} {
  const sent: RecordedSend[] = [];
  const sender: WeeklyCalibrationTelegramSender = {
    async sendMessage(chatId, text): Promise<void> {
      sent.push({ chatId, text });
    },
  };
  return { sender, sent };
}

const FIXED_NOW = new Date("2026-05-04T09:00:00.000Z"); // Monday 09:00 UTC
const WEEK_KEY = "2026-04-27"; // 7 days before today (UTC)

function makeDeps(
  client: ItemsQueryClient,
  sender: WeeklyCalibrationTelegramSender,
  overrides: Partial<WeeklyCalibrationDeps> = {},
): WeeklyCalibrationDeps {
  return {
    client,
    telegram: sender,
    plotStore: new InMemoryPlotStore(),
    publicUrl: "https://hn-pulse.test",
    clock: () => FIXED_NOW,
    ...overrides,
  };
}

function pred(
  predicted: number,
  outcome: 0 | 1,
  daysAgo = 1,
): FakePredictionRow {
  const first_seen_at = new Date(
    FIXED_NOW.getTime() - daysAgo * 24 * 60 * 60_000,
  );
  return {
    predicted_p: predicted,
    reached_front_page: outcome === 1,
    first_seen_at,
  };
}

describe("lastSevenDaysWindow", () => {
  it("returns the [today-7d, today) window in UTC", () => {
    const w = lastSevenDaysWindow(new Date("2026-05-04T09:00:00.000Z"));
    expect(w.fromUtc.toISOString()).toBe("2026-04-27T00:00:00.000Z");
    expect(w.toUtc.toISOString()).toBe("2026-05-04T00:00:00.000Z");
    expect(w.weekKey).toBe("2026-04-27");
  });

  it("crosses month boundary cleanly", () => {
    const w = lastSevenDaysWindow(new Date("2026-06-02T09:00:00.000Z"));
    expect(w.weekKey).toBe("2026-05-26");
  });
});

describe("msUntilNextWeeklyUtc", () => {
  it("returns ms to today's slot when not yet reached on the target dow", () => {
    // 2026-05-04 is a Monday. 08:00 UTC is before the 09:00 slot.
    const now = new Date("2026-05-04T08:00:00.000Z");
    expect(msUntilNextWeeklyUtc(now, 1, 9)).toBe(60 * 60_000);
  });

  it("rolls a full week forward when past today's slot on the target dow", () => {
    const now = new Date("2026-05-04T09:00:00.000Z");
    expect(msUntilNextWeeklyUtc(now, 1, 9)).toBe(7 * 24 * 60 * 60_000);
  });

  it("rolls forward to the right day of week when off-day", () => {
    // Tuesday 2026-05-05 → next Monday 09:00 is 6 days + 9 hours - now hour
    const now = new Date("2026-05-05T00:00:00.000Z");
    expect(msUntilNextWeeklyUtc(now, 1, 9)).toBe(6 * 24 * 60 * 60_000 + 9 * 60 * 60_000);
  });

  it("handles Sunday → Monday correctly", () => {
    const now = new Date("2026-05-03T12:00:00.000Z"); // Sunday 12:00
    expect(msUntilNextWeeklyUtc(now, 1, 9)).toBe(21 * 60 * 60_000);
  });
});

describe("brierScore", () => {
  it("returns 0 for an empty input", () => {
    expect(brierScore([])).toBe(0);
  });

  it("matches the published formula for a small sample", () => {
    // (0.8-1)^2 + (0.4-0)^2 + (0.6-1)^2 = 0.04 + 0.16 + 0.16 = 0.36
    // mean = 0.12
    const preds: WeeklyCalibrationPrediction[] = [
      { predicted: 0.8, outcome: 1 },
      { predicted: 0.4, outcome: 0 },
      { predicted: 0.6, outcome: 1 },
    ];
    expect(brierScore(preds)).toBeCloseTo(0.12, 6);
  });

  it("is 0 for perfect calibration", () => {
    const preds: WeeklyCalibrationPrediction[] = [
      { predicted: 1, outcome: 1 },
      { predicted: 0, outcome: 0 },
      { predicted: 1, outcome: 1 },
    ];
    expect(brierScore(preds)).toBe(0);
  });
});

describe("rocAuc", () => {
  it("returns 1.0 when positive scores strictly exceed negative scores", () => {
    const preds: WeeklyCalibrationPrediction[] = [
      { predicted: 0.9, outcome: 1 },
      { predicted: 0.8, outcome: 1 },
      { predicted: 0.4, outcome: 0 },
      { predicted: 0.2, outcome: 0 },
    ];
    expect(rocAuc(preds)).toBe(1);
  });

  it("returns 0.5 for ties between classes", () => {
    const preds: WeeklyCalibrationPrediction[] = [
      { predicted: 0.5, outcome: 1 },
      { predicted: 0.5, outcome: 0 },
      { predicted: 0.5, outcome: 1 },
      { predicted: 0.5, outcome: 0 },
    ];
    expect(rocAuc(preds)).toBe(0.5);
  });

  it("returns NaN for a single-class sample", () => {
    const allPos: WeeklyCalibrationPrediction[] = [
      { predicted: 0.9, outcome: 1 },
      { predicted: 0.6, outcome: 1 },
    ];
    expect(Number.isNaN(rocAuc(allPos))).toBe(true);
  });

  it("matches the rank-sum formula on a mixed sample", () => {
    // Sorted ascending by predicted: 0.1(0), 0.4(0), 0.5(1), 0.7(1)
    // Ranks for positives: 3, 4 → rank sum = 7
    // U = 7 - n+(n+1)/2 = 7 - 2*3/2 = 7 - 3 = 4
    // AUC = 4 / (2*2) = 1.0
    const preds: WeeklyCalibrationPrediction[] = [
      { predicted: 0.1, outcome: 0 },
      { predicted: 0.4, outcome: 0 },
      { predicted: 0.5, outcome: 1 },
      { predicted: 0.7, outcome: 1 },
    ];
    expect(rocAuc(preds)).toBe(1);
  });
});

describe("hitRateByBand", () => {
  it("buckets predictions into the configured threshold bands", () => {
    const preds: WeeklyCalibrationPrediction[] = [
      { predicted: 0.55, outcome: 1 },
      { predicted: 0.55, outcome: 0 },
      { predicted: 0.65, outcome: 1 },
      { predicted: 0.95, outcome: 1 },
      { predicted: 1.0, outcome: 0 },
      { predicted: 0.49, outcome: 1 }, // below all bands → ignored
    ];
    const stats = hitRateByBand(preds);
    expect(stats).toHaveLength(THRESHOLD_BANDS.length);
    expect(stats[0]).toMatchObject({
      band: [0.5, 0.6],
      total: 2,
      hits: 1,
      hitRate: 0.5,
    });
    expect(stats[1]).toMatchObject({
      band: [0.6, 0.7],
      total: 1,
      hits: 1,
      hitRate: 1,
    });
    expect(stats[2]).toMatchObject({ total: 0, hits: 0, hitRate: 0 });
    expect(stats[3]).toMatchObject({ total: 0, hits: 0, hitRate: 0 });
    expect(stats[4]).toMatchObject({ total: 2, hits: 1, hitRate: 0.5 });
  });

  it("returns 0 hit rate (not NaN) for empty bands", () => {
    const stats = hitRateByBand([]);
    for (const s of stats) {
      expect(s.total).toBe(0);
      expect(s.hits).toBe(0);
      expect(s.hitRate).toBe(0);
    }
  });
});

describe("renderCalibrationChart", () => {
  it("produces bytes that decode as a 600x400 RGBA PNG", () => {
    const stats = hitRateByBand([
      { predicted: 0.55, outcome: 1 },
      { predicted: 0.65, outcome: 0 },
      { predicted: 0.95, outcome: 1 },
    ]);
    const png = renderCalibrationChart(stats);
    expect(png.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
    const header = decodePngHeader(png);
    expect(header.width).toBe(600);
    expect(header.height).toBe(400);
    expect(header.bitDepth).toBe(8);
    expect(header.colorType).toBe(6);
    expect(png.length).toBeGreaterThan(100);
  });

  it("renders a chart even when there are no resolved predictions", () => {
    const png = renderCalibrationChart(hitRateByBand([]));
    expect(png.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
    const header = decodePngHeader(png);
    expect(header.width).toBe(600);
  });
});

describe("plotKeyFor / plotUrlFor", () => {
  it("composes a stable namespaced key", () => {
    expect(plotKeyFor("2026-04-27", "u-1")).toBe(
      "weekly-calibration/2026-04-27/u-1",
    );
  });

  it("strips trailing slash on publicUrl", () => {
    expect(plotUrlFor("https://hn-pulse.test/", "x/y")).toBe(
      "https://hn-pulse.test/plots/x/y.png",
    );
  });
});

describe("buildWeeklyCalibrationMessage", () => {
  it("includes Brier, AUC, per-band stats, and the plot URL", () => {
    const msg = buildWeeklyCalibrationMessage({
      weekKey: WEEK_KEY,
      predictionCount: 10,
      brier: 0.123,
      rocAuc: 0.78,
      bands: hitRateByBand([
        { predicted: 0.55, outcome: 1 },
        { predicted: 0.65, outcome: 0 },
      ]),
      plotUrl: "https://hn-pulse.test/plots/weekly-calibration/2026-04-27/u-1.png",
    });
    expect(msg).toContain(`week of ${WEEK_KEY}`);
    expect(msg).toContain("Brier score: 0.123");
    expect(msg).toContain("ROC AUC: 0.780");
    expect(msg).toContain("50-60%");
    expect(msg).toContain("60-70%");
    expect(msg).toContain(
      "https://hn-pulse.test/plots/weekly-calibration/2026-04-27/u-1.png",
    );
  });

  it("renders n/a when AUC is undefined (single-class week)", () => {
    const msg = buildWeeklyCalibrationMessage({
      weekKey: WEEK_KEY,
      predictionCount: 3,
      brier: 0,
      rocAuc: Number.NaN,
      bands: hitRateByBand([]),
      plotUrl: "https://hn-pulse.test/plots/x.png",
    });
    expect(msg).toContain("ROC AUC: n/a");
  });
});

describe("WEEKLY_CAL constants", () => {
  it("schedules the recap on Monday 09:00 UTC", () => {
    expect(WEEKLY_CAL_DAY_OF_WEEK).toBe(1);
    expect(WEEKLY_CAL_HOUR_UTC).toBe(9);
  });
});

describe("runWeeklyCalibration", () => {
  it("filters to pulse-pro users only and skips other tiers", async () => {
    const db = makeFakeDb({
      users: [
        {
          id: "u-pro",
          telegram_user_id: 100,
          tier: "pulse-pro",
          digest_opt_in: true,
        },
        {
          id: "u-pulse",
          telegram_user_id: 200,
          tier: "pulse",
          digest_opt_in: true,
        },
        {
          id: "u-free",
          telegram_user_id: 300,
          tier: "free",
          digest_opt_in: true,
        },
        {
          id: "u-canceled",
          telegram_user_id: 400,
          tier: "canceled",
          digest_opt_in: true,
        },
      ],
      predictions: [pred(0.85, 1), pred(0.3, 0), pred(0.65, 0)],
    });
    const tg = makeTelegram();

    const result = await runWeeklyCalibration(makeDeps(db.client, tg.sender));

    expect(result.eligibleUsers).toBe(1);
    expect(result.sent).toBe(1);
    expect(tg.sent).toHaveLength(1);
    expect(tg.sent[0]!.chatId).toBe(100);
    expect(tg.sent[0]!.text).toContain("Brier score:");
    expect(result.weekKey).toBe(WEEK_KEY);
    expect(result.predictionCount).toBe(3);
  });

  it("skips users with digest_opt_in=false even on pulse-pro", async () => {
    const db = makeFakeDb({
      users: [
        {
          id: "u-off",
          telegram_user_id: 500,
          tier: "pulse-pro",
          digest_opt_in: false,
        },
      ],
      predictions: [pred(0.85, 1)],
    });
    const tg = makeTelegram();

    const result = await runWeeklyCalibration(makeDeps(db.client, tg.sender));

    expect(result.eligibleUsers).toBe(0);
    expect(tg.sent).toHaveLength(0);
  });

  it("publishes a PNG plot reachable via the plot store at the message URL", async () => {
    const db = makeFakeDb({
      users: [
        {
          id: "u-pro",
          telegram_user_id: 100,
          tier: "pulse-pro",
          digest_opt_in: true,
        },
      ],
      predictions: [pred(0.55, 1), pred(0.85, 1), pred(0.2, 0)],
    });
    const tg = makeTelegram();
    const plotStore = new InMemoryPlotStore();

    await runWeeklyCalibration(makeDeps(db.client, tg.sender, { plotStore }));

    expect(tg.sent).toHaveLength(1);
    const text = tg.sent[0]!.text;
    const match = text.match(
      /https:\/\/hn-pulse\.test\/plots\/(weekly-calibration\/[^.\s]+)\.png/,
    );
    expect(match).not.toBeNull();
    const key = match![1]!;
    const png = await plotStore.get(key);
    expect(png).not.toBeNull();
    const header = decodePngHeader(png!);
    expect(header.width).toBe(600);
    expect(header.colorType).toBe(6);
    expect(png!.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
  });

  it("is idempotent on a second run within the same week", async () => {
    const db = makeFakeDb({
      users: [
        {
          id: "u-pro",
          telegram_user_id: 100,
          tier: "pulse-pro",
          digest_opt_in: true,
        },
      ],
      predictions: [pred(0.85, 1), pred(0.3, 0)],
    });
    const tg = makeTelegram();

    const first = await runWeeklyCalibration(makeDeps(db.client, tg.sender));
    const second = await runWeeklyCalibration(makeDeps(db.client, tg.sender));

    expect(first.sent).toBe(1);
    expect(second.sent).toBe(0);
    expect(second.skippedAlreadySent).toBe(1);
    expect(tg.sent).toHaveLength(1);
  });

  it("counts a delivery failure as failed but still claims the run row", async () => {
    const db = makeFakeDb({
      users: [
        {
          id: "u-pro",
          telegram_user_id: 100,
          tier: "pulse-pro",
          digest_opt_in: true,
        },
      ],
      predictions: [pred(0.85, 1), pred(0.3, 0)],
    });
    const sender: WeeklyCalibrationTelegramSender = {
      async sendMessage(): Promise<void> {
        throw new Error("telegram down");
      },
    };
    const errors: Array<{ err: unknown; label: string }> = [];

    const result = await runWeeklyCalibration(
      makeDeps(db.client, sender, {
        onError: (err, label) => errors.push({ err, label }),
      }),
    );

    expect(result.failed).toBe(1);
    expect(result.sent).toBe(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.label).toBe("weekly-calibration-send");
    expect(db.runs.has(`u-pro|${WEEK_KEY}`)).toBe(true);
  });

  it("runs the message path with zero resolved predictions (no AUC available)", async () => {
    const db = makeFakeDb({
      users: [
        {
          id: "u-pro",
          telegram_user_id: 100,
          tier: "pulse-pro",
          digest_opt_in: true,
        },
      ],
      predictions: [],
    });
    const tg = makeTelegram();

    const result = await runWeeklyCalibration(makeDeps(db.client, tg.sender));

    expect(result.sent).toBe(1);
    expect(result.predictionCount).toBe(0);
    expect(result.brier).toBeNull();
    expect(result.rocAuc).toBeNull();
    expect(tg.sent[0]!.text).toContain("ROC AUC: n/a");
  });

  it("returns early without querying predictions when there are no eligible users", async () => {
    const db = makeFakeDb({
      users: [],
      predictions: [pred(0.85, 1)],
    });
    const tg = makeTelegram();

    const result = await runWeeklyCalibration(makeDeps(db.client, tg.sender));

    expect(result.eligibleUsers).toBe(0);
    expect(result.sent).toBe(0);
    expect(tg.sent).toHaveLength(0);
  });
});
