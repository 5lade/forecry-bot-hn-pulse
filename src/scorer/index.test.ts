import { describe, expect, it } from "vitest";
import type { ItemsQueryClient } from "../db/items.js";
import {
  FIVE_MIN_MS,
  scoreAndInsertSnapshot,
  scoreSnapshot,
} from "./index.js";
import type { FeatureRow } from "./features.js";

interface Call {
  text: string;
  params?: ReadonlyArray<unknown>;
}

interface MockRouting {
  previousSnapshot?: {
    taken_at: Date;
    score: number | null;
    comments: number | null;
    p_front_page_6h: number | null;
  } | null;
  fiveMinAgoSnapshot?: {
    taken_at: Date;
    score: number | null;
    comments: number | null;
    p_front_page_6h: number | null;
  } | null;
}

function makeClient(routing: MockRouting = {}): {
  client: ItemsQueryClient;
  calls: Call[];
} {
  const calls: Call[] = [];
  let selectIndex = 0;
  const client: ItemsQueryClient = {
    async query<T extends Record<string, unknown>>(
      text: string,
      params?: ReadonlyArray<unknown>,
    ): Promise<{ rows: T[] }> {
      calls.push({ text, params });
      if (/SELECT\s+taken_at/i.test(text)) {
        // First SELECT: previous-snapshot lookup (taken_at < $2)
        // Second SELECT: 5-min-ago lookup (taken_at <= $2)
        const isPrev = /taken_at\s*<\s*\$2/i.test(text);
        const row = isPrev
          ? routing.previousSnapshot
          : routing.fiveMinAgoSnapshot;
        selectIndex += 1;
        if (row == null) return { rows: [] };
        return {
          rows: [
            {
              taken_at: row.taken_at,
              score: row.score,
              comments: row.comments,
              p_front_page_6h: row.p_front_page_6h,
            } as unknown as T,
          ],
        };
      }
      return { rows: [] };
    },
  };
  return { client, calls };
}

function findInsert(calls: Call[]): Call | undefined {
  return calls.find((c) => /INSERT INTO item_snapshots/i.test(c.text));
}

describe("scoreSnapshot", () => {
  it("delta_p_5min is current p minus prior probability", () => {
    const features: FeatureRow = {
      upvotes: 10,
      comments: 2,
      age_minutes: 15,
      score_velocity: 0,
      comment_velocity: 0,
      posting_hour_utc: 12,
      day_of_week: 3,
      domain: null,
      domain_reputation: 0,
      title_length: 20,
      has_show_hn: false,
      has_ask_hn: false,
      author_karma_bucket: "unknown",
    };
    const out = scoreSnapshot({
      features,
      previousProbabilityFiveMinAgo: 0.1,
    });
    expect(out.delta_p_5min).toBeCloseTo(out.p_front_page_6h - 0.1, 10);
  });

  it("delta_p_5min is 0 when no prior probability is available", () => {
    const features: FeatureRow = {
      upvotes: 10,
      comments: 2,
      age_minutes: 15,
      score_velocity: 0,
      comment_velocity: 0,
      posting_hour_utc: 12,
      day_of_week: 3,
      domain: null,
      domain_reputation: 0,
      title_length: 20,
      has_show_hn: false,
      has_ask_hn: false,
      author_karma_bucket: "unknown",
    };
    expect(
      scoreSnapshot({ features, previousProbabilityFiveMinAgo: null })
        .delta_p_5min,
    ).toBe(0);
  });
});

describe("scoreAndInsertSnapshot", () => {
  const POSTED = new Date("2026-05-07T13:00:00Z");
  const TAKEN = new Date("2026-05-07T13:30:00Z");

  it("populates a non-NULL p_front_page_6h on every insert", async () => {
    const { client, calls } = makeClient({});
    const result = await scoreAndInsertSnapshot(client, {
      item_id: 42,
      posted_at: POSTED,
      url: "https://example.com/post",
      title: "An ordinary submission",
      by: "alice",
      taken_at: TAKEN,
      rank: null,
      score: 5,
      comments: 1,
    });

    expect(result.p_front_page_6h).toBeGreaterThanOrEqual(0);
    expect(result.p_front_page_6h).toBeLessThanOrEqual(1);
    expect(Number.isFinite(result.p_front_page_6h)).toBe(true);

    const insert = findInsert(calls);
    expect(insert).toBeDefined();
    // Params: item_id, taken_at, rank, score, comments,
    // score_velocity, comment_velocity, p_front_page_6h, delta_p_5min
    expect(insert?.params?.[0]).toBe(42);
    expect(insert?.params?.[1]).toEqual(TAKEN);
    expect(insert?.params?.[7]).toBe(result.p_front_page_6h);
    expect(insert?.params?.[7]).not.toBeNull();
    expect(typeof insert?.params?.[7]).toBe("number");
  });

  it("computes delta_p_5min against a snapshot ~5 minutes ago", async () => {
    const fiveMinAgo = new Date(TAKEN.getTime() - FIVE_MIN_MS - 1_000);
    const previousP = 0.05;
    const { client, calls } = makeClient({
      previousSnapshot: {
        taken_at: fiveMinAgo,
        score: 1,
        comments: 0,
        p_front_page_6h: previousP,
      },
      fiveMinAgoSnapshot: {
        taken_at: fiveMinAgo,
        score: 1,
        comments: 0,
        p_front_page_6h: previousP,
      },
    });

    const result = await scoreAndInsertSnapshot(client, {
      item_id: 7,
      posted_at: POSTED,
      url: "https://example.com/x",
      title: "Test",
      taken_at: TAKEN,
      rank: null,
      score: 30,
      comments: 4,
    });

    expect(result.delta_p_5min).toBeCloseTo(
      result.p_front_page_6h - previousP,
      10,
    );

    const insert = findInsert(calls);
    expect(insert?.params?.[8]).toBe(result.delta_p_5min);
  });

  it("uses delta_p_5min = 0 when no ~5-minute-old snapshot exists", async () => {
    const { client, calls } = makeClient({
      // Previous snapshot exists (recent), but nothing ≥5 minutes old.
      previousSnapshot: {
        taken_at: new Date(TAKEN.getTime() - 60_000),
        score: 4,
        comments: 0,
        p_front_page_6h: 0.2,
      },
      fiveMinAgoSnapshot: null,
    });

    const result = await scoreAndInsertSnapshot(client, {
      item_id: 11,
      posted_at: POSTED,
      taken_at: TAKEN,
      rank: null,
      score: 5,
      comments: 1,
    });

    expect(result.delta_p_5min).toBe(0);
    const insert = findInsert(calls);
    expect(insert?.params?.[8]).toBe(0);
  });

  it("queries the 5-min cutoff ts when looking up the older snapshot", async () => {
    const { client, calls } = makeClient({});
    await scoreAndInsertSnapshot(client, {
      item_id: 99,
      posted_at: POSTED,
      taken_at: TAKEN,
      rank: null,
      score: 1,
      comments: 0,
    });

    const lookups = calls.filter((c) => /SELECT\s+taken_at/i.test(c.text));
    expect(lookups).toHaveLength(2);
    // The second SELECT (5-min-ago lookup) uses taken_at <= cutoff.
    const fiveMinLookup = lookups.find((c) =>
      /taken_at\s*<=\s*\$2/i.test(c.text),
    );
    expect(fiveMinLookup).toBeDefined();
    const cutoff = fiveMinLookup?.params?.[1] as Date;
    expect(cutoff.getTime()).toBe(TAKEN.getTime() - FIVE_MIN_MS);
  });

  it("uses the previous snapshot to compute non-zero score_velocity", async () => {
    const { client, calls } = makeClient({
      previousSnapshot: {
        taken_at: new Date(TAKEN.getTime() - 5 * 60_000),
        score: 4,
        comments: 1,
        p_front_page_6h: 0.05,
      },
      fiveMinAgoSnapshot: null,
    });

    const result = await scoreAndInsertSnapshot(client, {
      item_id: 5,
      posted_at: POSTED,
      taken_at: TAKEN,
      rank: null,
      score: 14, // +10 over 5min → 2/min
      comments: 1,
    });

    expect(result.score_velocity).toBeCloseTo(2, 5);
    const insert = findInsert(calls);
    expect(insert?.params?.[5]).toBeCloseTo(2, 5);
  });
});
