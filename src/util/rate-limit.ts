/**
 * Outbound rate limiter for Telegram sends.
 *
 * Telegram documents two relevant ceilings: ~30 messages/sec across the bot
 * and 1 message/sec per chat. We pick a defensive 25/sec global to leave
 * headroom for retries that bypass this limiter (e.g. honoring an explicit
 * 429 retry_after from the wire).
 *
 * Implementation is a sliding-window token bucket with two independent
 * windows (global, per-chat). Submissions for a given chat queue in FIFO
 * order, so message ordering for that chat is preserved even when overflow
 * waits for a refill.
 */

export interface RateLimiterOptions {
  /** Max sends in any rolling `globalWindowMs` window. Default 25. */
  globalLimit?: number;
  /** Length of the global rolling window in ms. Default 1000. */
  globalWindowMs?: number;
  /** Max sends per chat in any rolling `perChatWindowMs` window. Default 1. */
  perChatLimit?: number;
  /** Length of the per-chat rolling window in ms. Default 1000. */
  perChatWindowMs?: number;
  /** Clock injection point for tests. Defaults to `Date.now`. */
  now?: () => number;
  /** Timer injection point for tests. Defaults to `setTimeout` (unrefed). */
  schedule?: (fn: () => void, ms: number) => void;
}

interface PendingTask {
  fn: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

interface ChatState {
  queue: PendingTask[];
  /** Timestamps of recent dispatches, oldest first. */
  timestamps: number[];
}

const DEFAULT_GLOBAL_LIMIT = 25;
const DEFAULT_PER_CHAT_LIMIT = 1;
const DEFAULT_WINDOW_MS = 1000;

export class TokenBucketRateLimiter {
  private readonly globalLimit: number;
  private readonly globalWindowMs: number;
  private readonly perChatLimit: number;
  private readonly perChatWindowMs: number;
  private readonly nowFn: () => number;
  private readonly scheduleFn: (fn: () => void, ms: number) => void;

  private readonly globalTimestamps: number[] = [];
  private readonly chats = new Map<string, ChatState>();
  private timerPending = false;

  constructor(opts: RateLimiterOptions = {}) {
    this.globalLimit = opts.globalLimit ?? DEFAULT_GLOBAL_LIMIT;
    this.globalWindowMs = opts.globalWindowMs ?? DEFAULT_WINDOW_MS;
    this.perChatLimit = opts.perChatLimit ?? DEFAULT_PER_CHAT_LIMIT;
    this.perChatWindowMs = opts.perChatWindowMs ?? DEFAULT_WINDOW_MS;
    this.nowFn = opts.now ?? (() => Date.now());
    this.scheduleFn =
      opts.schedule ??
      ((fn, ms) => {
        const t = setTimeout(fn, ms);
        // Don't keep the event loop alive solely for the rate limiter.
        (t as { unref?: () => void }).unref?.();
      });
  }

  /**
   * Submit a task tied to `chatKey`. Returns a promise that resolves with
   * the task's return value once both buckets allow the dispatch.
   * Tasks for the same `chatKey` are dispatched in submission order.
   */
  submit<T>(chatKey: string, fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let chat = this.chats.get(chatKey);
      if (!chat) {
        chat = { queue: [], timestamps: [] };
        this.chats.set(chatKey, chat);
      }
      chat.queue.push({
        fn: fn as () => Promise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this.tick();
    });
  }

  private purge(timestamps: number[], windowMs: number, now: number): void {
    const cutoff = now - windowMs;
    while (timestamps.length > 0 && timestamps[0]! <= cutoff) {
      timestamps.shift();
    }
  }

  private tick(): void {
    const now = this.nowFn();
    this.purge(this.globalTimestamps, this.globalWindowMs, now);

    let progress = true;
    while (progress) {
      progress = false;
      if (this.globalTimestamps.length >= this.globalLimit) break;
      for (const chat of this.chats.values()) {
        if (chat.queue.length === 0) continue;
        if (this.globalTimestamps.length >= this.globalLimit) break;
        this.purge(chat.timestamps, this.perChatWindowMs, now);
        if (chat.timestamps.length >= this.perChatLimit) continue;
        const task = chat.queue.shift()!;
        this.globalTimestamps.push(now);
        chat.timestamps.push(now);
        // Run the task as a microtask but attach handlers eagerly so a
        // rejected `task.fn()` never floats through the loop unhandled.
        void (async () => {
          try {
            task.resolve(await task.fn());
          } catch (err) {
            task.reject(err);
          }
        })();
        progress = true;
      }
    }

    if (this.timerPending) return;
    let earliest = Infinity;
    const globalReadyAt =
      this.globalTimestamps.length >= this.globalLimit
        ? this.globalTimestamps[0]! + this.globalWindowMs
        : now;
    for (const chat of this.chats.values()) {
      if (chat.queue.length === 0) continue;
      const chatReadyAt =
        chat.timestamps.length >= this.perChatLimit
          ? chat.timestamps[0]! + this.perChatWindowMs
          : now;
      const readyAt = Math.max(globalReadyAt, chatReadyAt);
      if (readyAt < earliest) earliest = readyAt;
    }
    if (earliest !== Infinity) {
      const delay = Math.max(1, earliest - now);
      this.timerPending = true;
      this.scheduleFn(() => {
        this.timerPending = false;
        this.tick();
      }, delay);
    }
  }
}
