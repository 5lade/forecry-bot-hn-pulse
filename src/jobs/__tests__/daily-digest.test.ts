import { describe, expect, it } from "vitest";
import type { ItemsQueryClient } from "../../db/items.js";
import {
  buildDigestMessage,
  runDailyDigest,
  yesterdayUtcWindow,
  type DailyDigestDeps,
  type DigestTelegramSender,
} from "../daily-digest.js";

interface FakeUserRow {
  id: string;
  telegram_user_id: number;
  tier: "free" | "pulse" | "pulse-pro" | "canceled";
  threshold_pct: number;
  digest_opt_in: boolean;
}

interface FakeItemRow {
  item_id: number;
  title: string | null;
  url: string | null;
  domain: string | null;
  by: string | null;
  first_seen_at: Date;
  predicted_p: number | null;
  final_rank: number | null;
  final_p: number | null;
}

interface FakeDb {
  users: FakeUserRow[];
  /** Pre-seeded per-user tracked items keyed by user id. */
  trackedByUser: Map<string, FakeItemRow[]>;
  /** Captured (user_id|digest_date) digest_runs rows. */
  digestRuns: Set<string>;
  client: ItemsQueryClient;
  callLog: Array<{ text: string; params?: ReadonlyArray<unknown> }>;
}

function makeFakeDb(seed: {
  users?: FakeUserRow[];
  trackedByUser?: Record<string, FakeItemRow[]>;
}): FakeDb {
  const users = [...(seed.users ?? [])];
  const trackedByUser = new Map<string, FakeItemRow[]>();
  for (const [k, v] of Object.entries(seed.trackedByUser ?? {})) {
    trackedByUser.set(k, [...v]);
  }
  const digestRuns = new Set<string>();
  const callLog: FakeDb["callLog"] = [];

  const client: ItemsQueryClient = {
    async query<T extends Record<string, unknown>>(
      text: string,
      params?: ReadonlyArray<unknown>,
    ): Promise<{ rows: T[] }> {
      callLog.push({ text, params });
      const sql = text.trim();

      if (
        /^SELECT[\s\S]*FROM users\b[\s\S]*digest_opt_in\s*=\s*TRUE/i.test(sql)
      ) {
        const rows = users
          .filter(
            (u) =>
              u.digest_opt_in &&
              (u.tier === "pulse" || u.tier === "pulse-pro"),
          )
          .map((u) => ({
            id: u.id,
            telegram_user_id: u.telegram_user_id,
            threshold_pct: u.threshold_pct,
            tier: u.tier,
          }));
        return { rows: rows as unknown as T[] };
      }

      if (/^WITH user_items AS/i.test(sql)) {
        const userId = String(params![0]);
        const fromUtc = params![1] as Date;
        const toUtc = params![2] as Date;
        const all = trackedByUser.get(userId) ?? [];
        const rows = all
          .filter(
            (it) =>
              it.first_seen_at.getTime() >= fromUtc.getTime() &&
              it.first_seen_at.getTime() < toUtc.getTime(),
          )
          .sort((a, b) => a.first_seen_at.getTime() - b.first_seen_at.getTime());
        return { rows: rows as unknown as T[] };
      }

      if (/^INSERT INTO digest_runs/i.test(sql)) {
        const userId = String(params![0]);
        const digestDate = String(params![1]);
        const key = `${userId}|${digestDate}`;
        if (digestRuns.has(key)) {
          return { rows: [] };
        }
        digestRuns.add(key);
        return { rows: [{ user_id: userId } as unknown as T] };
      }

      throw new Error(`FakeDb: unhandled SQL: ${sql.slice(0, 80)}`);
    },
  };

  return { users, trackedByUser, digestRuns, client, callLog };
}

interface RecordedSend {
  chatId: number;
  text: string;
}

function makeTelegram(): {
  sender: DigestTelegramSender;
  sent: RecordedSend[];
} {
  const sent: RecordedSend[] = [];
  const sender: DigestTelegramSender = {
    async sendMessage(chatId, text): Promise<void> {
      sent.push({ chatId, text });
    },
  };
  return { sender, sent };
}

const FIXED_NOW = new Date("2026-05-08T09:00:00.000Z");
const YESTERDAY_DATE = "2026-05-07";

function makeDeps(
  client: ItemsQueryClient,
  sender: DigestTelegramSender,
  overrides: Partial<DailyDigestDeps> = {},
): DailyDigestDeps {
  return {
    client,
    telegram: sender,
    publicUrl: "https://hn-pulse.test",
    clock: () => FIXED_NOW,
    ...overrides,
  };
}

function trackedItem(overrides: Partial<FakeItemRow> & { item_id: number }): FakeItemRow {
  return {
    item_id: overrides.item_id,
    title: overrides.title ?? `Item ${overrides.item_id}`,
    url: overrides.url ?? `https://example.com/${overrides.item_id}`,
    domain: overrides.domain ?? "example.com",
    by: overrides.by ?? "alice",
    first_seen_at:
      overrides.first_seen_at ?? new Date("2026-05-07T12:00:00.000Z"),
    predicted_p: overrides.predicted_p ?? 0.45,
    final_rank: overrides.final_rank ?? null,
    final_p: overrides.final_p ?? 0.5,
  };
}

describe("yesterdayUtcWindow", () => {
  it("returns the [00:00, 24:00) UTC window for the day before now", () => {
    const w = yesterdayUtcWindow(new Date("2026-05-08T09:00:00.000Z"));
    expect(w.fromUtc.toISOString()).toBe("2026-05-07T00:00:00.000Z");
    expect(w.toUtc.toISOString()).toBe("2026-05-08T00:00:00.000Z");
    expect(w.digestDate).toBe("2026-05-07");
  });

  it("handles month rollover", () => {
    const w = yesterdayUtcWindow(new Date("2026-06-01T09:00:00.000Z"));
    expect(w.digestDate).toBe("2026-05-31");
  });
});

describe("buildDigestMessage", () => {
  it("formats hits/misses summary and includes calibration link", () => {
    const msg = buildDigestMessage({
      user: {
        id: "u-1",
        telegram_user_id: 100,
        threshold_pct: 60,
        tier: "pulse",
      },
      digestDate: YESTERDAY_DATE,
      items: [
        trackedItem({ item_id: 1, final_rank: 5, predicted_p: 0.7 }),
        trackedItem({ item_id: 2, final_rank: null, predicted_p: 0.6 }),
      ],
      publicUrl: "https://hn-pulse.test",
    });
    expect(msg).toContain(`HN Pulse digest — ${YESTERDAY_DATE}`);
    expect(msg).toContain("Tracked 2 items: 1 hit, 1 miss.");
    expect(msg).toContain("https://news.ycombinator.com/item?id=1");
    expect(msg).toContain("https://hn-pulse.test/calibration/u-1");
  });
});

describe("runDailyDigest", () => {
  it("sends one digest per eligible user with tracked items", async () => {
    const db = makeFakeDb({
      users: [
        {
          id: "u-1",
          telegram_user_id: 100,
          tier: "pulse",
          threshold_pct: 60,
          digest_opt_in: true,
        },
      ],
      trackedByUser: {
        "u-1": [
          trackedItem({
            item_id: 11,
            title: "First Cool Post",
            final_rank: 8,
            predicted_p: 0.72,
          }),
          trackedItem({
            item_id: 12,
            title: "Missed The Cut",
            final_rank: null,
            predicted_p: 0.55,
          }),
        ],
      },
    });
    const tg = makeTelegram();

    const result = await runDailyDigest(makeDeps(db.client, tg.sender));

    expect(result.eligibleUsers).toBe(1);
    expect(result.sent).toBe(1);
    expect(result.skippedEmpty).toBe(0);
    expect(result.skippedAlreadySent).toBe(0);
    expect(result.failed).toBe(0);
    expect(tg.sent).toHaveLength(1);
    expect(tg.sent[0]!.chatId).toBe(100);
    expect(tg.sent[0]!.text).toContain("First Cool Post");
    expect(tg.sent[0]!.text).toContain("Missed The Cut");
    expect(tg.sent[0]!.text).toContain("1 hit, 1 miss");
    expect(db.digestRuns.has(`u-1|${YESTERDAY_DATE}`)).toBe(true);
  });

  it("skips free-tier users entirely", async () => {
    const db = makeFakeDb({
      users: [
        {
          id: "u-free",
          telegram_user_id: 200,
          tier: "free",
          threshold_pct: 80,
          digest_opt_in: true,
        },
        {
          id: "u-canceled",
          telegram_user_id: 201,
          tier: "canceled",
          threshold_pct: 60,
          digest_opt_in: true,
        },
      ],
      trackedByUser: {
        "u-free": [trackedItem({ item_id: 1 })],
        "u-canceled": [trackedItem({ item_id: 2 })],
      },
    });
    const tg = makeTelegram();

    const result = await runDailyDigest(makeDeps(db.client, tg.sender));

    expect(result.eligibleUsers).toBe(0);
    expect(result.sent).toBe(0);
    expect(tg.sent).toHaveLength(0);
  });

  it("skips eligible users with no tracked items (empty user)", async () => {
    const db = makeFakeDb({
      users: [
        {
          id: "u-empty",
          telegram_user_id: 300,
          tier: "pulse",
          threshold_pct: 60,
          digest_opt_in: true,
        },
      ],
      trackedByUser: {},
    });
    const tg = makeTelegram();

    const result = await runDailyDigest(makeDeps(db.client, tg.sender));

    expect(result.eligibleUsers).toBe(1);
    expect(result.sent).toBe(0);
    expect(result.skippedEmpty).toBe(1);
    expect(tg.sent).toHaveLength(0);
    expect(db.digestRuns.size).toBe(0);
  });

  it("is idempotent: a second run on the same day sends nothing", async () => {
    const db = makeFakeDb({
      users: [
        {
          id: "u-1",
          telegram_user_id: 100,
          tier: "pulse",
          threshold_pct: 60,
          digest_opt_in: true,
        },
      ],
      trackedByUser: {
        "u-1": [trackedItem({ item_id: 21, final_rank: 12 })],
      },
    });
    const tg = makeTelegram();

    const first = await runDailyDigest(makeDeps(db.client, tg.sender));
    const second = await runDailyDigest(makeDeps(db.client, tg.sender));

    expect(first.sent).toBe(1);
    expect(second.sent).toBe(0);
    expect(second.skippedAlreadySent).toBe(1);
    expect(tg.sent).toHaveLength(1);
    expect(db.digestRuns.size).toBe(1);
  });

  it("skips digest_opt_in=false even on paid tier", async () => {
    const db = makeFakeDb({
      users: [
        {
          id: "u-off",
          telegram_user_id: 400,
          tier: "pulse",
          threshold_pct: 60,
          digest_opt_in: false,
        },
      ],
      trackedByUser: {
        "u-off": [trackedItem({ item_id: 99 })],
      },
    });
    const tg = makeTelegram();

    const result = await runDailyDigest(makeDeps(db.client, tg.sender));

    expect(result.eligibleUsers).toBe(0);
    expect(tg.sent).toHaveLength(0);
  });

  it("counts a delivery failure as failed but still claims the digest_run row", async () => {
    const db = makeFakeDb({
      users: [
        {
          id: "u-fail",
          telegram_user_id: 500,
          tier: "pulse",
          threshold_pct: 60,
          digest_opt_in: true,
        },
      ],
      trackedByUser: {
        "u-fail": [trackedItem({ item_id: 50, final_rank: 3 })],
      },
    });
    const sender: DigestTelegramSender = {
      async sendMessage(): Promise<void> {
        throw new Error("telegram down");
      },
    };
    const errors: Array<{ err: unknown; label: string }> = [];

    const result = await runDailyDigest(
      makeDeps(db.client, sender, {
        onError: (err, label) => errors.push({ err, label }),
      }),
    );

    expect(result.failed).toBe(1);
    expect(result.sent).toBe(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.label).toBe("digest-send");
    expect(db.digestRuns.has(`u-fail|${YESTERDAY_DATE}`)).toBe(true);
  });
});
