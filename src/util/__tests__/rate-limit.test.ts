import { describe, expect, it } from "vitest";
import { TokenBucketRateLimiter } from "../rate-limit.js";

interface FakeTimer {
  fireAt: number;
  fn: () => void;
}

function makeClock() {
  const state = {
    now: 0,
    timers: [] as FakeTimer[],
  };
  const nowFn = (): number => state.now;
  const schedule = (fn: () => void, ms: number): void => {
    state.timers.push({ fireAt: state.now + ms, fn });
  };
  const flushMicrotasks = (): Promise<void> =>
    new Promise<void>((r) => {
      setImmediate(r);
    });
  const drain = async (): Promise<void> => {
    // Flush any microtasks queued by synchronous submits.
    await flushMicrotasks();
    while (state.timers.length > 0) {
      state.timers.sort((a, b) => a.fireAt - b.fireAt);
      const next = state.timers.shift()!;
      state.now = Math.max(state.now, next.fireAt);
      next.fn();
      await flushMicrotasks();
    }
    await flushMicrotasks();
  };
  return { state, nowFn, schedule, drain };
}

describe("TokenBucketRateLimiter — burst", () => {
  it("dispatches all 200 messages without exceeding 25 per rolling 1s window", async () => {
    const clock = makeClock();
    const limiter = new TokenBucketRateLimiter({
      globalLimit: 25,
      perChatLimit: 1,
      now: clock.nowFn,
      schedule: clock.schedule,
    });
    const dispatchTimes: number[] = [];

    const promises: Promise<void>[] = [];
    for (let i = 0; i < 200; i++) {
      // 100 distinct chats, two messages per chat → exercises both gates.
      const chatKey = `chat-${i % 100}`;
      promises.push(
        limiter.submit(chatKey, async () => {
          dispatchTimes.push(clock.nowFn());
        }),
      );
    }

    await clock.drain();
    await Promise.all(promises);

    expect(dispatchTimes).toHaveLength(200);

    // No 1-second rolling window should contain more than 25 dispatches —
    // the same condition Telegram enforces with its 429 response.
    const sorted = [...dispatchTimes].sort((a, b) => a - b);
    for (let i = 0; i < sorted.length; i++) {
      let count = 0;
      for (let j = i; j < sorted.length && sorted[j]! < sorted[i]! + 1000; j++) {
        count++;
      }
      expect(count).toBeLessThanOrEqual(25);
    }
  });

  it("fills the global bucket on the first tick (capacity 25 dispatch immediately)", async () => {
    const clock = makeClock();
    const limiter = new TokenBucketRateLimiter({
      globalLimit: 25,
      perChatLimit: 1,
      now: clock.nowFn,
      schedule: clock.schedule,
    });
    const dispatchTimes: number[] = [];

    const promises: Promise<void>[] = [];
    for (let i = 0; i < 50; i++) {
      promises.push(
        limiter.submit(`chat-${i}`, async () => {
          dispatchTimes.push(clock.nowFn());
        }),
      );
    }

    // Let synchronous dispatches resolve before draining timers.
    await new Promise<void>((r) => {
      setImmediate(r);
    });

    expect(dispatchTimes).toHaveLength(25);
    expect(dispatchTimes.every((t) => t === 0)).toBe(true);

    await clock.drain();
    await Promise.all(promises);

    expect(dispatchTimes).toHaveLength(50);
  });
});

describe("TokenBucketRateLimiter — per-chat ordering", () => {
  it("preserves FIFO order for messages addressed to the same chat", async () => {
    const clock = makeClock();
    const limiter = new TokenBucketRateLimiter({
      globalLimit: 25,
      perChatLimit: 1,
      now: clock.nowFn,
      schedule: clock.schedule,
    });
    const dispatchOrder: number[] = [];

    const promises: Promise<void>[] = [];
    for (let i = 0; i < 5; i++) {
      const idx = i;
      promises.push(
        limiter.submit("only-chat", async () => {
          dispatchOrder.push(idx);
        }),
      );
    }

    await clock.drain();
    await Promise.all(promises);

    expect(dispatchOrder).toEqual([0, 1, 2, 3, 4]);
  });

  it("interleaves chats while keeping each chat's order intact", async () => {
    const clock = makeClock();
    const limiter = new TokenBucketRateLimiter({
      globalLimit: 25,
      perChatLimit: 1,
      now: clock.nowFn,
      schedule: clock.schedule,
    });
    const dispatched: Array<{ chat: string; seq: number; at: number }> = [];

    const promises: Promise<void>[] = [];
    // 3 chats × 4 messages each. Per-chat 1/sec means each chat sees its
    // messages spaced ≥1s apart; sequence numbers must remain monotonic.
    for (let i = 0; i < 12; i++) {
      const chat = `chat-${i % 3}`;
      const seq = Math.floor(i / 3);
      promises.push(
        limiter.submit(chat, async () => {
          dispatched.push({ chat, seq, at: clock.nowFn() });
        }),
      );
    }

    await clock.drain();
    await Promise.all(promises);

    expect(dispatched).toHaveLength(12);
    for (const chat of ["chat-0", "chat-1", "chat-2"]) {
      const seqs = dispatched.filter((d) => d.chat === chat).map((d) => d.seq);
      expect(seqs).toEqual([0, 1, 2, 3]);
    }
  });

  it("waits ~1s between two messages addressed to the same chat", async () => {
    const clock = makeClock();
    const limiter = new TokenBucketRateLimiter({
      globalLimit: 25,
      perChatLimit: 1,
      now: clock.nowFn,
      schedule: clock.schedule,
    });
    const dispatchTimes: number[] = [];

    const p1 = limiter.submit("chat-x", async () => {
      dispatchTimes.push(clock.nowFn());
    });
    const p2 = limiter.submit("chat-x", async () => {
      dispatchTimes.push(clock.nowFn());
    });

    await clock.drain();
    await Promise.all([p1, p2]);

    expect(dispatchTimes).toHaveLength(2);
    expect(dispatchTimes[0]).toBe(0);
    // Second dispatch must respect the per-chat 1-second window.
    expect(dispatchTimes[1]! - dispatchTimes[0]!).toBeGreaterThanOrEqual(1000);
  });
});

describe("TokenBucketRateLimiter — task results", () => {
  it("propagates resolved values and rejection reasons through submit", async () => {
    const clock = makeClock();
    const limiter = new TokenBucketRateLimiter({
      now: clock.nowFn,
      schedule: clock.schedule,
    });

    const ok = limiter.submit("c", async () => 42);
    const fail = limiter.submit("c", async () => {
      throw new Error("boom");
    });
    // In real usage callers `await submit(...)`; pre-attach a no-op handler
    // so vitest doesn't flag the deferred rejection while we drain timers.
    fail.catch(() => {});

    await clock.drain();

    await expect(ok).resolves.toBe(42);
    await expect(fail).rejects.toThrow("boom");
  });
});
