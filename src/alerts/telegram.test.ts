import { describe, expect, it } from "vitest";
import type { ItemsQueryClient } from "../db/items.js";
import { TokenBucketRateLimiter } from "../util/rate-limit.js";
import { RetryAfterError } from "../util/retry.js";
import type { AlertEnvelope } from "./sender.js";
import {
  TelegramAlertSender,
  formatTelegramAlertMessage,
  resolveTelegramChatId,
} from "./telegram.js";

interface QueryCall {
  text: string;
  params?: ReadonlyArray<unknown>;
}

interface DeadletterRow {
  id: string;
  alert_payload: string;
  error_message: string;
  attempts: number;
  created_at: Date;
}

interface FakeDb {
  client: ItemsQueryClient;
  calls: QueryCall[];
  deadletters: DeadletterRow[];
}

function makeDb(): FakeDb {
  const calls: QueryCall[] = [];
  const deadletters: DeadletterRow[] = [];
  const client: ItemsQueryClient = {
    async query<T extends Record<string, unknown>>(
      text: string,
      params?: ReadonlyArray<unknown>,
    ): Promise<{ rows: T[] }> {
      calls.push({ text, params });
      if (/^INSERT INTO alerts_deadletter/i.test(text.trim())) {
        deadletters.push({
          id: String(params?.[0]),
          alert_payload: String(params?.[1]),
          error_message: String(params?.[2]),
          attempts: Number(params?.[3]),
          created_at: params?.[4] as Date,
        });
      }
      return { rows: [] as T[] };
    },
  };
  return { client, calls, deadletters };
}

function envelope(overrides: Partial<AlertEnvelope> = {}): AlertEnvelope {
  return {
    alert_id: "alert-1",
    user_id: "u-1",
    item_id: 42,
    alert_type: "threshold",
    payload: {
      kind: "threshold",
      pFrontPage6h: 0.9,
      thresholdPct: 60,
      title: "x",
      url: null,
      domain: null,
      by: null,
    } as unknown as AlertEnvelope["payload"],
    ...overrides,
  };
}

describe("Telegram alert helpers", () => {
  it("resolves an internal user id to users.telegram_user_id", async () => {
    const calls: QueryCall[] = [];
    const client: ItemsQueryClient = {
      async query<T extends Record<string, unknown>>(
        text: string,
        params?: ReadonlyArray<unknown>,
      ): Promise<{ rows: T[] }> {
        calls.push({ text, params });
        return {
          rows: [{ telegram_user_id: "123456" }] as unknown as T[],
        };
      },
    };

    await expect(resolveTelegramChatId(client, "u-1")).resolves.toBe(123456);
    expect(calls[0]!.text).toMatch(/FROM users/);
    expect(calls[0]!.params).toEqual(["u-1"]);
  });

  it("formats a Telegram alert with the HN item link and watch context", () => {
    const text = formatTelegramAlertMessage(
      envelope({
        item_id: 123,
        payload: {
          watch_type: "domain",
          watch_value: "example.com",
          p_front_page_6h: 0.765,
          delta_p_5min: 0.04,
          threshold_pct: 70,
        },
      }),
    );

    expect(text).toContain("77% front-page probability");
    expect(text).toContain("domain:example.com");
    expect(text).toContain("https://news.ycombinator.com/item?id=123");
  });
});

describe("TelegramAlertSender — happy path", () => {
  it("sends successfully on the first try and writes no deadletter", async () => {
    const db = makeDb();
    const sent: Array<{ chatId: number | string; text: string }> = [];
    const sender = new TelegramAlertSender({
      api: {
        async sendMessage(chatId, text) {
          sent.push({ chatId, text });
        },
      },
      client: db.client,
      resolveChatId: async () => 100,
      formatMessage: () => "hello",
    });
    await sender.send(envelope());
    expect(sent).toEqual([{ chatId: 100, text: "hello" }]);
    expect(db.deadletters).toHaveLength(0);
  });
});

describe("TelegramAlertSender — 429 handling", () => {
  it("honors retry_after seconds from a 429 then succeeds on retry", async () => {
    const db = makeDb();
    const sleeps: number[] = [];
    let n = 0;
    const sender = new TelegramAlertSender({
      api: {
        async sendMessage() {
          n += 1;
          if (n === 1) {
            // grammy-shaped 429
            throw {
              error_code: 429,
              description: "Too Many Requests: retry after 4",
              parameters: { retry_after: 4 },
            };
          }
        },
      },
      client: db.client,
      resolveChatId: async () => 100,
      formatMessage: () => "hello",
      retryOptions: {
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    });
    await sender.send(envelope());
    expect(n).toBe(2);
    expect(sleeps).toEqual([4000]);
    expect(db.deadletters).toHaveLength(0);
  });

  it("falls back to a 1s wait when retry_after is missing on 429", async () => {
    const db = makeDb();
    const sleeps: number[] = [];
    let n = 0;
    const sender = new TelegramAlertSender({
      api: {
        async sendMessage() {
          n += 1;
          if (n === 1) {
            throw {
              error_code: 429,
              description: "Too Many Requests",
              parameters: {},
            };
          }
        },
      },
      client: db.client,
      resolveChatId: async () => 100,
      formatMessage: () => "hello",
      retryOptions: {
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    });
    await sender.send(envelope());
    expect(sleeps).toEqual([1000]);
  });

  it("writes a deadletter row after exhausting 3 attempts on persistent 429", async () => {
    const db = makeDb();
    let n = 0;
    const fixedNow = new Date("2026-05-07T12:00:00Z");
    const sender = new TelegramAlertSender({
      api: {
        async sendMessage() {
          n += 1;
          throw {
            error_code: 429,
            description: "Too Many Requests: retry after 1",
            parameters: { retry_after: 1 },
          };
        },
      },
      client: db.client,
      resolveChatId: async () => 100,
      formatMessage: () => "hello",
      retryOptions: { sleep: async () => {} },
      generateId: () => "dl-1",
      now: () => fixedNow,
    });
    await expect(sender.send(envelope())).rejects.toBeInstanceOf(
      RetryAfterError,
    );
    // max 3 attempts on telegram path
    expect(n).toBe(3);
    expect(db.deadletters).toHaveLength(1);
    const dl = db.deadletters[0]!;
    expect(dl.id).toBe("dl-1");
    expect(dl.attempts).toBe(3);
    expect(dl.created_at).toEqual(fixedNow);
    const decoded = JSON.parse(dl.alert_payload) as AlertEnvelope;
    expect(decoded.alert_id).toBe("alert-1");
    expect(decoded.user_id).toBe("u-1");
    expect(decoded.item_id).toBe(42);
    expect(decoded.alert_type).toBe("threshold");
  });
});

describe("TelegramAlertSender — terminal failure paths", () => {
  it("retries on 5xx then deadletters after 3 attempts", async () => {
    const db = makeDb();
    let n = 0;
    const sender = new TelegramAlertSender({
      api: {
        async sendMessage() {
          n += 1;
          throw {
            error_code: 500,
            description: "Internal Server Error",
            parameters: {},
          };
        },
      },
      client: db.client,
      resolveChatId: async () => 100,
      formatMessage: () => "hello",
      retryOptions: { sleep: async () => {} },
      generateId: () => "dl-2",
    });
    await expect(sender.send(envelope())).rejects.toBeTruthy();
    expect(n).toBe(3);
    expect(db.deadletters).toHaveLength(1);
    expect(db.deadletters[0]!.attempts).toBe(3);
    expect(db.deadletters[0]!.error_message).toMatch(/Internal Server Error/);
  });

  it("does not retry 4xx (other than 429) but still writes deadletter", async () => {
    const db = makeDb();
    let n = 0;
    const sender = new TelegramAlertSender({
      api: {
        async sendMessage() {
          n += 1;
          throw {
            error_code: 403,
            description: "Forbidden: bot was blocked by the user",
            parameters: {},
          };
        },
      },
      client: db.client,
      resolveChatId: async () => 100,
      formatMessage: () => "hello",
      retryOptions: { sleep: async () => {} },
      generateId: () => "dl-3",
    });
    await expect(sender.send(envelope())).rejects.toBeTruthy();
    expect(n).toBe(1);
    expect(db.deadletters).toHaveLength(1);
    expect(db.deadletters[0]!.attempts).toBe(1);
  });

  it("creates a deadletter with attempts=0 when the chat id cannot be resolved", async () => {
    const db = makeDb();
    let sendCalls = 0;
    const sender = new TelegramAlertSender({
      api: {
        async sendMessage() {
          sendCalls += 1;
        },
      },
      client: db.client,
      resolveChatId: async () => null,
      formatMessage: () => "hello",
      generateId: () => "dl-4",
    });
    await sender.send(envelope());
    expect(sendCalls).toBe(0);
    expect(db.deadletters).toHaveLength(1);
    expect(db.deadletters[0]!.attempts).toBe(0);
    expect(db.deadletters[0]!.error_message).toBe("no chat id for user");
  });

  it("invokes onError on terminal failure", async () => {
    const db = makeDb();
    const errors: Array<{ err: unknown; label: string }> = [];
    const sender = new TelegramAlertSender({
      api: {
        async sendMessage() {
          throw new Error("boom");
        },
      },
      client: db.client,
      resolveChatId: async () => 100,
      formatMessage: () => "hello",
      retryOptions: { sleep: async () => {} },
      onError: (err, label) => errors.push({ err, label }),
      generateId: () => "dl-5",
    });
    await expect(sender.send(envelope())).rejects.toThrow("boom");
    expect(errors).toHaveLength(1);
    expect(errors[0]!.label).toBe("telegram-send");
  });
});

describe("TelegramAlertSender — rate limiting", () => {
  function makeFakeClock() {
    const state = {
      now: 0,
      timers: [] as Array<{ fireAt: number; fn: () => void }>,
    };
    const flush = (): Promise<void> =>
      new Promise<void>((r) => {
        setImmediate(r);
      });
    return {
      state,
      nowFn: (): number => state.now,
      schedule: (fn: () => void, ms: number): void => {
        state.timers.push({ fireAt: state.now + ms, fn });
      },
      flush,
      drain: async (): Promise<void> => {
        await flush();
        while (state.timers.length > 0) {
          state.timers.sort((a, b) => a.fireAt - b.fireAt);
          const next = state.timers.shift()!;
          state.now = Math.max(state.now, next.fireAt);
          next.fn();
          await flush();
        }
        await flush();
      },
    };
  }

  it("burst of 200 messages does not 429 and preserves per-chat ordering", async () => {
    const db = makeDb();
    const clock = makeFakeClock();
    const limiter = new TokenBucketRateLimiter({
      globalLimit: 25,
      perChatLimit: 1,
      now: clock.nowFn,
      schedule: clock.schedule,
    });

    // Fake Telegram api that mirrors the wire 429 contract: rejects with
    // grammy-shaped 429 if more than 25 calls land in any 1-sec window OR
    // if a single chat is hit more than once per second.
    const callsByChat = new Map<number, number[]>();
    const allCallTimes: number[] = [];
    const dispatchOrder: Array<{ chatId: number; seq: number }> = [];

    const sender = new TelegramAlertSender({
      api: {
        async sendMessage(chatId) {
          const id = chatId as number;
          const t = clock.nowFn();
          // Global cap: 25 within last 1000ms.
          const inGlobalWindow = allCallTimes.filter((x) => x > t - 1000).length;
          if (inGlobalWindow >= 25) {
            throw {
              error_code: 429,
              description: "Too Many Requests: global cap exceeded",
              parameters: { retry_after: 1 },
            };
          }
          // Per-chat cap: 1 within last 1000ms.
          const chatCalls = callsByChat.get(id) ?? [];
          const inChatWindow = chatCalls.filter((x) => x > t - 1000).length;
          if (inChatWindow >= 1) {
            throw {
              error_code: 429,
              description: "Too Many Requests: per-chat cap exceeded",
              parameters: { retry_after: 1 },
            };
          }
          allCallTimes.push(t);
          chatCalls.push(t);
          callsByChat.set(id, chatCalls);
        },
      },
      client: db.client,
      // Map user_id "u-{i}" → chat id (i % 100). Two messages share each chat
      // when i and i+100 collide on the same chat.
      resolveChatId: async (userId) => {
        const m = /u-(\d+)/.exec(userId);
        return m ? Number(m[1]) % 100 : null;
      },
      formatMessage: (env) => `m-${env.alert_id}`,
      rateLimiter: limiter,
    });

    const promises: Promise<void>[] = [];
    for (let i = 0; i < 200; i++) {
      const env = envelope({
        alert_id: `a-${i}`,
        user_id: `u-${i}`,
      });
      const seq = Math.floor(i / 100); // 0 for first pass, 1 for second
      const chatId = i % 100;
      const p = sender.send(env).then(() => {
        dispatchOrder.push({ chatId, seq });
      });
      // Pre-attach a no-op so a hypothetical reject doesn't surface as
      // "rejection handled asynchronously" while we drain timers.
      p.catch(() => {});
      promises.push(p);
    }

    await clock.drain();
    await Promise.all(promises);

    // All 200 reached Telegram successfully (no 429 ever surfaced).
    expect(allCallTimes).toHaveLength(200);
    expect(db.deadletters).toHaveLength(0);

    // No rolling 1-second window contains > 25 sends.
    const sorted = [...allCallTimes].sort((a, b) => a - b);
    for (let i = 0; i < sorted.length; i++) {
      let count = 0;
      for (let j = i; j < sorted.length && sorted[j]! < sorted[i]! + 1000; j++) {
        count++;
      }
      expect(count).toBeLessThanOrEqual(25);
    }

    // Per-chat ordering preserved: each chat saw seq=0 strictly before seq=1.
    for (let chatId = 0; chatId < 100; chatId++) {
      const seqs = dispatchOrder
        .filter((d) => d.chatId === chatId)
        .map((d) => d.seq);
      expect(seqs).toEqual([0, 1]);
    }
  });
});
