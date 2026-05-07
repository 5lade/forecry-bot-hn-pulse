import { describe, expect, it } from "vitest";
import {
  HttpError,
  RetryAfterError,
  exponentialDelayMs,
  retry,
} from "../retry.js";

function statusErr(status: number): Error {
  return new HttpError(status, `HTTP ${status}`);
}

describe("exponentialDelayMs", () => {
  it("doubles each attempt with jitter()=1 (full multiplier 1.0)", () => {
    expect(exponentialDelayMs(1, 100, 100_000, () => 1)).toBe(100);
    expect(exponentialDelayMs(2, 100, 100_000, () => 1)).toBe(200);
    expect(exponentialDelayMs(3, 100, 100_000, () => 1)).toBe(400);
    expect(exponentialDelayMs(4, 100, 100_000, () => 1)).toBe(800);
  });

  it("applies jitter()=0 → 0.5x floor", () => {
    expect(exponentialDelayMs(1, 200, 100_000, () => 0)).toBe(100);
    expect(exponentialDelayMs(2, 200, 100_000, () => 0)).toBe(200);
  });

  it("caps the exponential growth at maxMs", () => {
    expect(exponentialDelayMs(1, 1000, 2000, () => 1)).toBe(1000);
    expect(exponentialDelayMs(2, 1000, 2000, () => 1)).toBe(2000);
    expect(exponentialDelayMs(3, 1000, 2000, () => 1)).toBe(2000);
    expect(exponentialDelayMs(99, 1000, 2000, () => 1)).toBe(2000);
  });
});

describe("retry — backoff schedule", () => {
  it("retries up to maxAttempts and produces exponential schedule with jitter()=1", async () => {
    const sleeps: number[] = [];
    let n = 0;
    await expect(
      retry(
        async () => {
          n += 1;
          throw statusErr(503);
        },
        {
          sleep: async (ms) => {
            sleeps.push(ms);
          },
          jitter: () => 1,
          baseMs: 100,
          maxMs: 100_000,
          maxAttempts: 4,
        },
      ),
    ).rejects.toBeInstanceOf(HttpError);
    expect(n).toBe(4);
    // 3 sleeps between 4 attempts: 100, 200, 400.
    expect(sleeps).toEqual([100, 200, 400]);
  });

  it("with jitter()=0 produces the floor (0.5x) schedule", async () => {
    const sleeps: number[] = [];
    let n = 0;
    await expect(
      retry(
        async () => {
          n += 1;
          throw statusErr(500);
        },
        {
          sleep: async (ms) => {
            sleeps.push(ms);
          },
          jitter: () => 0,
          baseMs: 100,
          maxMs: 100_000,
          maxAttempts: 4,
        },
      ),
    ).rejects.toBeInstanceOf(HttpError);
    expect(sleeps).toEqual([50, 100, 200]);
  });

  it("caps backoff at maxMs across many attempts", async () => {
    const sleeps: number[] = [];
    let n = 0;
    await expect(
      retry(
        async () => {
          n += 1;
          throw statusErr(503);
        },
        {
          sleep: async (ms) => {
            sleeps.push(ms);
          },
          jitter: () => 1,
          baseMs: 1000,
          maxMs: 2000,
          maxAttempts: 5,
        },
      ),
    ).rejects.toBeInstanceOf(HttpError);
    // 4 sleeps. Without cap: 1000, 2000, 4000, 8000. Capped: 1000, 2000, 2000, 2000.
    expect(sleeps).toEqual([1000, 2000, 2000, 2000]);
  });

  it("succeeds before exhausting attempts", async () => {
    let n = 0;
    const out = await retry(
      async () => {
        n += 1;
        if (n < 3) throw statusErr(503);
        return "ok";
      },
      { sleep: async () => {}, jitter: () => 0, baseMs: 1, maxAttempts: 5 },
    );
    expect(out).toBe("ok");
    expect(n).toBe(3);
  });

  it("does not retry non-retryable errors", async () => {
    let n = 0;
    await expect(
      retry(
        async () => {
          n += 1;
          throw new Error("bug");
        },
        { sleep: async () => {} },
      ),
    ).rejects.toThrow("bug");
    expect(n).toBe(1);
  });

  it("treats 4xx as non-retryable by default", async () => {
    let n = 0;
    await expect(
      retry(
        async () => {
          n += 1;
          throw statusErr(404);
        },
        { sleep: async () => {} },
      ),
    ).rejects.toBeInstanceOf(HttpError);
    expect(n).toBe(1);
  });

  it("default maxAttempts is 5", async () => {
    let n = 0;
    await expect(
      retry(
        async () => {
          n += 1;
          throw statusErr(503);
        },
        { sleep: async () => {}, jitter: () => 0, baseMs: 1 },
      ),
    ).rejects.toBeInstanceOf(HttpError);
    expect(n).toBe(5);
  });
});

describe("retry — RetryAfterError handling (Telegram 429)", () => {
  it("uses retryAfterMs verbatim instead of exponential backoff", async () => {
    const sleeps: number[] = [];
    let n = 0;
    const out = await retry(
      async () => {
        n += 1;
        if (n === 1) throw new RetryAfterError(2500, "429");
        return "ok";
      },
      {
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        jitter: () => 0,
        baseMs: 100,
      },
    );
    expect(out).toBe("ok");
    expect(sleeps).toEqual([2500]);
  });

  it("respects RetryAfterError across multiple retries", async () => {
    const sleeps: number[] = [];
    let n = 0;
    const out = await retry(
      async () => {
        n += 1;
        if (n === 1) throw new RetryAfterError(1000, "first");
        if (n === 2) throw new RetryAfterError(3000, "second");
        return "ok";
      },
      {
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    );
    expect(out).toBe("ok");
    expect(sleeps).toEqual([1000, 3000]);
  });

  it("RetryAfterError still respects maxAttempts (max 3 for telegram path)", async () => {
    let n = 0;
    await expect(
      retry(
        async () => {
          n += 1;
          throw new RetryAfterError(10, "429");
        },
        { sleep: async () => {}, maxAttempts: 3 },
      ),
    ).rejects.toBeInstanceOf(RetryAfterError);
    expect(n).toBe(3);
  });
});

describe("retry — custom isRetryable", () => {
  it("invokes the provided predicate to decide retry vs throw", async () => {
    let n = 0;
    const out = await retry(
      async () => {
        n += 1;
        if (n === 1) throw new Error("transient-please-retry");
        return n;
      },
      {
        sleep: async () => {},
        isRetryable: (err) =>
          err instanceof Error && err.message.startsWith("transient-"),
      },
    );
    expect(out).toBe(2);
    expect(n).toBe(2);
  });
});
