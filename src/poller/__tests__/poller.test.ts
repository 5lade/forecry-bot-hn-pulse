import { describe, expect, it, vi } from "vitest";
import type { ItemsQueryClient } from "../../db/items.js";
import { type FetchResponseLike } from "../hn.js";
import {
  HN_NEWSTORIES_HEARTBEAT_SERVICE,
  _resetLastBatchAtForTest,
  getLastBatchAt,
  pollNewStoriesStep,
  rescanStep,
} from "../index.js";

interface QueryCall {
  text: string;
  params?: ReadonlyArray<unknown>;
}

function makeClient(rowsByPattern: Array<{ match: RegExp; rows: unknown[] }>): {
  client: ItemsQueryClient;
  calls: QueryCall[];
} {
  const calls: QueryCall[] = [];
  const client: ItemsQueryClient = {
    async query<T extends Record<string, unknown>>(
      text: string,
      params?: ReadonlyArray<unknown>,
    ): Promise<{ rows: T[] }> {
      calls.push({ text, params });
      for (const r of rowsByPattern) {
        if (r.match.test(text)) return { rows: r.rows as T[] };
      }
      return { rows: [] };
    },
  };
  return { client, calls };
}

function jsonResponse(body: unknown, status = 200): FetchResponseLike {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}

describe("pollNewStoriesStep — new-item insert", () => {
  it("upserts each new item and inserts a snapshot", async () => {
    _resetLastBatchAtForTest();

    const { client, calls } = makeClient([]);
    const seen = new Set<number>([100]);
    const now = new Date("2025-01-01T00:00:00Z");

    const items: Record<number, unknown> = {
      101: {
        id: 101,
        by: "alice",
        title: "Hello",
        url: "https://example.com/a",
        time: Math.floor(now.getTime() / 1000) - 60,
        type: "story",
        score: 5,
        descendants: 1,
      },
      102: {
        id: 102,
        by: "bob",
        title: "World",
        url: "https://news.ycombinator.com/item?id=102",
        time: Math.floor(now.getTime() / 1000) - 30,
        type: "story",
        score: 2,
        descendants: 0,
      },
    };

    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/newstories.json")) {
        return jsonResponse([101, 102, 100]);
      }
      const m = url.match(/\/item\/(\d+)\.json$/);
      if (m) {
        const id = Number(m[1]);
        return jsonResponse(items[id] ?? null);
      }
      return jsonResponse(null, 404);
    });

    const result = await pollNewStoriesStep({
      client,
      seen,
      hn: {
        fetchImpl,
        backoff: { sleep: () => Promise.resolve(), jitter: () => 0 },
      },
      now: () => now,
    });

    expect(result.newIds).toEqual([101, 102]);
    expect(result.inserted).toBe(2);
    expect(result.skipped).toBe(0);

    const upserts = calls.filter((c) => /INSERT INTO items/i.test(c.text));
    expect(upserts).toHaveLength(2);

    const upsert101 = upserts.find((c) => c.params?.[0] === 101);
    expect(upsert101).toBeDefined();
    expect(upsert101?.params).toEqual([
      101,
      "alice",
      "Hello",
      "https://example.com/a",
      "example.com",
      new Date((Math.floor(now.getTime() / 1000) - 60) * 1000),
      now,
    ]);

    const snapshots = calls.filter((c) =>
      /INSERT INTO item_snapshots/i.test(c.text),
    );
    expect(snapshots).toHaveLength(2);
    const snap101 = snapshots.find((c) => c.params?.[0] === 101);
    expect(snap101?.params?.slice(0, 6)).toEqual([
      101,
      now,
      null, // rank
      5, // score
      1, // comments
      0, // score_velocity (no previous snapshot)
    ]);
    // p_front_page_6h is param[7]; must be a finite number in [0,1].
    const p = snap101?.params?.[7];
    expect(typeof p).toBe("number");
    expect(p as number).toBeGreaterThanOrEqual(0);
    expect(p as number).toBeLessThanOrEqual(1);

    expect(seen.has(101)).toBe(true);
    expect(seen.has(102)).toBe(true);
    const heartbeat = calls.find((c) =>
      /INSERT INTO service_heartbeats/i.test(c.text),
    );
    expect(heartbeat?.params).toEqual([
      HN_NEWSTORIES_HEARTBEAT_SERVICE,
      now,
      JSON.stringify({
        fresh_count: 3,
        new_count: 2,
        inserted: 2,
        skipped: 0,
      }),
    ]);
    expect(getLastBatchAt()).toEqual(now);
  });

  it("skips dead/deleted items but still adds them to seen", async () => {
    _resetLastBatchAtForTest();
    const { client, calls } = makeClient([]);
    const seen = new Set<number>();
    const now = new Date("2025-01-02T00:00:00Z");

    const fetchImpl = async (url: string) => {
      if (url.endsWith("/newstories.json")) return jsonResponse([200, 201]);
      if (url.endsWith("/item/200.json"))
        return jsonResponse({ id: 200, dead: true, type: "story" });
      if (url.endsWith("/item/201.json"))
        return jsonResponse({ id: 201, deleted: true });
      return jsonResponse(null);
    };

    const result = await pollNewStoriesStep({
      client,
      seen,
      hn: { fetchImpl, backoff: { sleep: () => Promise.resolve() } },
      now: () => now,
    });
    expect(result.inserted).toBe(0);
    expect(result.skipped).toBe(2);
    expect(seen.has(200)).toBe(true);
    expect(seen.has(201)).toBe(true);
    expect(calls.filter((c) => /INSERT INTO items/i.test(c.text))).toHaveLength(
      0,
    );
  });

  it("records liveness heartbeat even when all fetched ids were already seen", async () => {
    _resetLastBatchAtForTest();
    const { client, calls } = makeClient([]);
    const seen = new Set<number>([300, 301]);
    const now = new Date("2025-01-02T00:05:00Z");

    const fetchImpl = async (url: string) => {
      if (url.endsWith("/newstories.json")) return jsonResponse([300, 301]);
      return jsonResponse(null, 404);
    };

    const result = await pollNewStoriesStep({
      client,
      seen,
      hn: { fetchImpl, backoff: { sleep: () => Promise.resolve() } },
      now: () => now,
    });

    expect(result).toEqual({ newIds: [], inserted: 0, skipped: 0 });
    expect(calls.some((c) => /INSERT INTO items/i.test(c.text))).toBe(false);
    const heartbeat = calls.find((c) =>
      /INSERT INTO service_heartbeats/i.test(c.text),
    );
    expect(heartbeat?.params).toEqual([
      HN_NEWSTORIES_HEARTBEAT_SERVICE,
      now,
      JSON.stringify({
        fresh_count: 2,
        new_count: 0,
        inserted: 0,
        skipped: 0,
      }),
    ]);
    expect(getLastBatchAt()).toEqual(now);
  });
});

describe("rescanStep", () => {
  it("inserts a snapshot per item younger than window", async () => {
    _resetLastBatchAtForTest();
    const now = new Date("2025-01-03T00:00:00Z");
    const { client, calls } = makeClient([
      {
        match: /SELECT id, first_seen_at\s+FROM items/i,
        rows: [
          { id: 11, first_seen_at: new Date(now.getTime() - 60_000) },
          { id: 12, first_seen_at: new Date(now.getTime() - 120_000) },
        ],
      },
    ]);

    const fetchImpl = async (url: string) => {
      const m = url.match(/\/item\/(\d+)\.json$/);
      if (!m) return jsonResponse(null, 404);
      const id = Number(m[1]);
      return jsonResponse({ id, score: id, descendants: id * 2, type: "story" });
    };

    const result = await rescanStep({
      client,
      hn: { fetchImpl, backoff: { sleep: () => Promise.resolve() } },
      now: () => now,
      windowHours: 6,
    });

    expect(result.scanned).toBe(2);
    expect(result.snapshots).toBe(2);
    const snapshots = calls.filter((c) =>
      /INSERT INTO item_snapshots/i.test(c.text),
    );
    expect(snapshots).toHaveLength(2);
    expect(getLastBatchAt()).toEqual(now);
  });

  it("records top-30 ranks and marks items that reached the front page", async () => {
    _resetLastBatchAtForTest();
    const now = new Date("2025-01-03T00:10:00Z");
    const { client, calls } = makeClient([
      {
        match: /SELECT id, first_seen_at\s+FROM items/i,
        rows: [
          { id: 11, first_seen_at: new Date(now.getTime() - 60_000) },
          { id: 12, first_seen_at: new Date(now.getTime() - 120_000) },
        ],
      },
    ]);

    const fetchImpl = async (url: string) => {
      if (url.endsWith("/topstories.json")) return jsonResponse([99, 11, 12]);
      const m = url.match(/\/item\/(\d+)\.json$/);
      if (!m) return jsonResponse(null, 404);
      const id = Number(m[1]);
      return jsonResponse({ id, score: id, descendants: id * 2, type: "story" });
    };

    const result = await rescanStep({
      client,
      hn: { fetchImpl, backoff: { sleep: () => Promise.resolve() } },
      now: () => now,
      windowHours: 6,
      concurrency: 1,
    });

    expect(result).toEqual({ scanned: 2, snapshots: 2 });

    const markReached = calls.filter((c) => /SET reached_front_page = TRUE/i.test(c.text));
    expect(markReached.map((c) => c.params)).toEqual([
      [11, now],
      [12, now],
    ]);

    const snapshots = calls.filter((c) =>
      /INSERT INTO item_snapshots/i.test(c.text),
    );
    expect(snapshots.find((c) => c.params?.[0] === 11)?.params?.[2]).toBe(2);
    expect(snapshots.find((c) => c.params?.[0] === 12)?.params?.[2]).toBe(3);

    const resolvedMisses = calls.find((c) => /SET reached_front_page = FALSE/i.test(c.text));
    expect(resolvedMisses?.params).toEqual([
      new Date(now.getTime() - 6 * 60 * 60 * 1000),
    ]);
  });
});
