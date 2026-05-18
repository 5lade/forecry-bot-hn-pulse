import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  diffNewIds,
  extractDomain,
  fetchItem,
  fetchNewStoryIds,
  fetchTopStoryIds,
  HttpError,
  withBackoff,
  type FetchResponseLike,
} from "../hn.js";

function jsonResponse(body: unknown, status = 200): FetchResponseLike {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}

describe("diffNewIds", () => {
  it("returns only ids not present in seen, preserving order", () => {
    const seen = new Set<number>([1, 2, 3]);
    expect(diffNewIds(seen, [3, 4, 1, 5, 2, 6])).toEqual([4, 5, 6]);
  });

  it("returns empty when all ids are seen", () => {
    expect(diffNewIds(new Set([1, 2]), [1, 2])).toEqual([]);
  });

  it("returns all ids when seen is empty", () => {
    expect(diffNewIds(new Set(), [10, 11, 12])).toEqual([10, 11, 12]);
  });
});

describe("extractDomain", () => {
  it("returns hostname for valid URL", () => {
    expect(extractDomain("https://example.com/foo")).toBe("example.com");
  });
  it("returns null for invalid URL", () => {
    expect(extractDomain("not a url")).toBeNull();
  });
  it("returns null for null/undefined", () => {
    expect(extractDomain(null)).toBeNull();
    expect(extractDomain(undefined)).toBeNull();
  });
});

describe("withBackoff", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries on retryable HttpError and eventually succeeds", async () => {
    let attempts = 0;
    const sleeps: number[] = [];
    const sleep = (ms: number) => {
      sleeps.push(ms);
      return Promise.resolve();
    };
    const result = await withBackoff(
      async () => {
        attempts += 1;
        if (attempts < 3) throw new HttpError(503, "boom");
        return "ok";
      },
      { sleep, jitter: () => 0.5, baseMs: 100, maxMs: 10000 },
    );
    expect(result).toBe("ok");
    expect(attempts).toBe(3);
    expect(sleeps).toHaveLength(2);
    expect(sleeps[0]).toBeGreaterThan(0);
  });

  it("does not retry non-retryable errors", async () => {
    let attempts = 0;
    await expect(
      withBackoff(
        async () => {
          attempts += 1;
          throw new HttpError(404, "not found");
        },
        { sleep: () => Promise.resolve() },
      ),
    ).rejects.toBeInstanceOf(HttpError);
    expect(attempts).toBe(1);
  });

  it("gives up after maxAttempts", async () => {
    let attempts = 0;
    await expect(
      withBackoff(
        async () => {
          attempts += 1;
          throw new HttpError(500, "always");
        },
        { sleep: () => Promise.resolve(), maxAttempts: 3 },
      ),
    ).rejects.toBeInstanceOf(HttpError);
    expect(attempts).toBe(3);
  });
});

describe("fetchNewStoryIds", () => {
  it("returns the array of ids on 200", async () => {
    const ids = await fetchNewStoryIds({
      fetchImpl: async () => jsonResponse([10, 20, 30]),
      backoff: { sleep: () => Promise.resolve() },
    });
    expect(ids).toEqual([10, 20, 30]);
  });

  it("filters out non-numeric values defensively", async () => {
    const ids = await fetchNewStoryIds({
      fetchImpl: async () => jsonResponse([1, "x", 2, null, 3]),
      backoff: { sleep: () => Promise.resolve() },
    });
    expect(ids).toEqual([1, 2, 3]);
  });

  it("retries on 5xx then succeeds (HN poller acceptance)", async () => {
    let n = 0;
    const fetchImpl = vi.fn(async () => {
      n += 1;
      if (n <= 2) return jsonResponse(null, 503);
      return jsonResponse([1, 2]);
    });
    const ids = await fetchNewStoryIds({
      fetchImpl,
      backoff: {
        sleep: () => Promise.resolve(),
        jitter: () => 0,
        baseMs: 1,
      },
    });
    expect(ids).toEqual([1, 2]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});

describe("fetchTopStoryIds", () => {
  it("returns numeric ids from topstories", async () => {
    const ids = await fetchTopStoryIds({
      fetchImpl: async () => jsonResponse([10, "x", 20, null, 30]),
      backoff: { sleep: () => Promise.resolve() },
    });
    expect(ids).toEqual([10, 20, 30]);
  });

  it("uses the topstories endpoint", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([1]));
    await fetchTopStoryIds({
      fetchImpl,
      baseUrl: "https://hn.test/v0",
      backoff: { sleep: () => Promise.resolve() },
    });
    expect(fetchImpl).toHaveBeenCalledWith("https://hn.test/v0/topstories.json");
  });
});

describe("fetchItem", () => {
  it("returns the parsed item on 200", async () => {
    const item = await fetchItem(42, {
      fetchImpl: async () =>
        jsonResponse({ id: 42, title: "hello", by: "alice", time: 100 }),
      backoff: { sleep: () => Promise.resolve() },
    });
    expect(item).toEqual({ id: 42, title: "hello", by: "alice", time: 100 });
  });

  it("retries on 503 twice then 200 (acceptance)", async () => {
    let n = 0;
    const fetchImpl = vi.fn(async () => {
      n += 1;
      if (n <= 2) return jsonResponse(null, 503);
      return jsonResponse({ id: 7, title: "ok" });
    });
    const item = await fetchItem(7, {
      fetchImpl,
      backoff: { sleep: () => Promise.resolve(), jitter: () => 0, baseMs: 1 },
    });
    expect(item).toEqual({ id: 7, title: "ok" });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("throws after exhausting retries on persistent 500", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(null, 500));
    await expect(
      fetchItem(1, {
        fetchImpl,
        backoff: {
          sleep: () => Promise.resolve(),
          jitter: () => 0,
          baseMs: 1,
          maxAttempts: 4,
        },
      }),
    ).rejects.toBeInstanceOf(HttpError);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });
});
