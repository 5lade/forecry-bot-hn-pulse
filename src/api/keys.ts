/**
 * pulse-pro REST API (POST /v1/...) auth + rate limiting.
 *
 * Spec.md §6 plans pulse-pro: "API key". Bearer tokens live in the api_keys
 * table; we never store plaintext, only SHA-256(key) + a display prefix.
 * Lookup hashes the bearer once per request and joins users to expose the
 * caller's tier. Revoked keys (revoked_at IS NOT NULL) are treated like
 * unknown keys — 401, never 403.
 *
 * Rate limit: 60 req/min per key. We use a sliding window of timestamps in
 * an in-memory map; this is fine for a single-process MVP. The window is
 * keyed by api_keys.id so multiple processes that share a DB but not memory
 * each get their own 60/min — acceptable for the current single-Node-process
 * deploy and easy to swap for Redis later.
 */

import type { Request, Response, NextFunction } from "express";
import { createHash } from "node:crypto";

export interface ApiAuthQueryClient {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: ReadonlyArray<unknown>,
  ): Promise<{ rows: T[] }>;
}

export interface ApiCaller {
  apiKeyId: string;
  userId: string;
  telegramUserId: number;
  tier: string;
  thresholdPct: number;
}

export interface AuthMiddlewareOptions {
  client: ApiAuthQueryClient;
  rateLimiter?: ApiRateLimiter;
  /** Touch api_keys.last_used_at on a successful auth. Default: true. */
  touchLastUsed?: boolean;
  now?: () => Date;
}

export function hashApiKey(plaintext: string): string {
  return createHash("sha256").update(plaintext, "utf8").digest("hex");
}

interface ApiKeyRow {
  api_key_id: string;
  user_id: string;
  telegram_user_id: number | string;
  tier: string;
  threshold_pct: number | string;
  [key: string]: unknown;
}

export async function lookupApiKey(
  client: ApiAuthQueryClient,
  plaintext: string,
): Promise<ApiCaller | null> {
  const trimmed = plaintext.trim();
  if (!trimmed) return null;
  const hash = hashApiKey(trimmed);
  const res = await client.query<ApiKeyRow>(
    `SELECT k.id AS api_key_id,
            u.id AS user_id,
            u.telegram_user_id,
            u.tier,
            u.threshold_pct
       FROM api_keys k
       JOIN users u ON u.id = k.user_id
      WHERE k.key_hash = $1
        AND k.revoked_at IS NULL
      LIMIT 1`,
    [hash],
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    apiKeyId: row.api_key_id,
    userId: row.user_id,
    telegramUserId: Number(row.telegram_user_id),
    tier: row.tier,
    thresholdPct: Number(row.threshold_pct),
  };
}

async function touchLastUsedAt(
  client: ApiAuthQueryClient,
  apiKeyId: string,
  at: Date,
): Promise<void> {
  await client.query(
    `UPDATE api_keys SET last_used_at = $2 WHERE id = $1`,
    [apiKeyId, at],
  );
}

export function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!m) return null;
  const token = m[1]?.trim();
  return token ? token : null;
}

export interface ApiRateLimitOptions {
  /** Max requests per key in any rolling `windowMs` window. Default 60. */
  limit?: number;
  /** Length of the rolling window in ms. Default 60_000. */
  windowMs?: number;
  now?: () => number;
}

export interface RateCheckResult {
  allowed: boolean;
  /** Seconds until the bucket would let the next request through. 0 if allowed. */
  retryAfterSeconds: number;
}

/**
 * Sliding-window rate limiter keyed by api_keys.id. Each key tracks the
 * timestamps of its recent allowed requests; if the window is full the call
 * is rejected with the wait time until the oldest entry ages out.
 */
export class ApiRateLimiter {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly nowFn: () => number;
  private readonly buckets = new Map<string, number[]>();

  constructor(opts: ApiRateLimitOptions = {}) {
    this.limit = opts.limit ?? 60;
    this.windowMs = opts.windowMs ?? 60_000;
    this.nowFn = opts.now ?? (() => Date.now());
  }

  check(key: string): RateCheckResult {
    const now = this.nowFn();
    const cutoff = now - this.windowMs;
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = [];
      this.buckets.set(key, bucket);
    }
    while (bucket.length > 0 && bucket[0]! <= cutoff) {
      bucket.shift();
    }
    if (bucket.length >= this.limit) {
      const oldest = bucket[0]!;
      const waitMs = oldest + this.windowMs - now;
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)),
      };
    }
    bucket.push(now);
    return { allowed: true, retryAfterSeconds: 0 };
  }
}

export interface AuthedRequest extends Request {
  apiCaller?: ApiCaller;
}

/**
 * Express middleware that gates a route on a valid bearer token and the
 * 60/min rate limit. On success it attaches `req.apiCaller` and calls
 * next(); on failure it ends the response with the right status code.
 */
export function makeApiAuthMiddleware(opts: AuthMiddlewareOptions) {
  const client = opts.client;
  const rateLimiter = opts.rateLimiter ?? new ApiRateLimiter();
  const touch = opts.touchLastUsed ?? true;
  const nowFn = opts.now ?? (() => new Date());

  return async function apiAuthMiddleware(
    req: AuthedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const token = extractBearerToken(
      req.header("authorization") ?? req.header("Authorization"),
    );
    if (!token) {
      res
        .status(401)
        .set("WWW-Authenticate", 'Bearer realm="hn-pulse"')
        .json({ error: "missing bearer token" });
      return;
    }

    let caller: ApiCaller | null;
    try {
      caller = await lookupApiKey(client, token);
    } catch {
      res.status(500).json({ error: "auth lookup failed" });
      return;
    }
    if (!caller) {
      res
        .status(401)
        .set("WWW-Authenticate", 'Bearer realm="hn-pulse"')
        .json({ error: "invalid bearer token" });
      return;
    }

    const result = rateLimiter.check(caller.apiKeyId);
    if (!result.allowed) {
      res
        .status(429)
        .set("Retry-After", String(result.retryAfterSeconds))
        .json({
          error: "rate limit exceeded",
          retry_after_seconds: result.retryAfterSeconds,
        });
      return;
    }

    if (touch) {
      // Fire-and-forget: don't block the request on the timestamp write.
      void touchLastUsedAt(client, caller.apiKeyId, nowFn()).catch(() => {});
    }

    req.apiCaller = caller;
    next();
  };
}
