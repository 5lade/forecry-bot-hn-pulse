/**
 * Centralized retry primitives shared by the HN poller and Telegram sender.
 *
 * - Exponential backoff with jitter for generic transient failures (5xx).
 * - `RetryAfterError` carries an explicit wait derived from a server hint
 *   (e.g. Telegram's 429 `parameters.retry_after`); the helper honors it
 *   verbatim instead of computing exponential backoff.
 */

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export class RetryAfterError extends Error {
  constructor(
    public readonly retryAfterMs: number,
    message?: string,
  ) {
    super(message ?? `retry after ${retryAfterMs}ms`);
    this.name = "RetryAfterError";
  }
}

export interface RetryOptions {
  maxAttempts?: number;
  baseMs?: number;
  maxMs?: number;
  jitter?: () => number;
  sleep?: (ms: number) => Promise<void>;
  isRetryable?: (err: unknown) => boolean;
}

export const DEFAULT_MAX_ATTEMPTS = 5;
export const DEFAULT_BASE_MS = 250;
export const DEFAULT_MAX_MS = 8000;

const defaultIsRetryable = (err: unknown): boolean => {
  if (err instanceof RetryAfterError) return true;
  if (typeof err === "object" && err !== null && "status" in err) {
    const status = (err as { status: unknown }).status;
    return typeof status === "number" && status >= 500 && status < 600;
  }
  return false;
};

export function exponentialDelayMs(
  attempt: number,
  baseMs: number,
  maxMs: number,
  jitter: () => number,
): number {
  const expo = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
  // jitter in [0, 1) → multiplier in [0.5, 1.0). Decorrelated from raw value
  // so callers can pin jitter()=0 or 1 in tests for a deterministic schedule.
  return expo * (0.5 + jitter() * 0.5);
}

export async function retry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const baseMs = opts.baseMs ?? DEFAULT_BASE_MS;
  const maxMs = opts.maxMs ?? DEFAULT_MAX_MS;
  const jitter = opts.jitter ?? Math.random;
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const isRetryable = opts.isRetryable ?? defaultIsRetryable;

  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      attempt += 1;
      if (attempt >= maxAttempts || !isRetryable(err)) {
        throw err;
      }
      const delay =
        err instanceof RetryAfterError
          ? err.retryAfterMs
          : exponentialDelayMs(attempt, baseMs, maxMs, jitter);
      await sleep(delay);
    }
  }
}
