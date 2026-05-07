import { describe, expect, it } from "vitest";
import {
  ApiRateLimiter,
  extractBearerToken,
  hashApiKey,
  lookupApiKey,
  type ApiAuthQueryClient,
} from "../keys.js";

interface Call {
  text: string;
  params?: ReadonlyArray<unknown>;
}

function recordingClient(rows: unknown[] = []): {
  client: ApiAuthQueryClient;
  calls: Call[];
} {
  const calls: Call[] = [];
  const client: ApiAuthQueryClient = {
    async query<T extends Record<string, unknown>>(
      text: string,
      params?: ReadonlyArray<unknown>,
    ): Promise<{ rows: T[] }> {
      calls.push({ text, params });
      return { rows: rows as T[] };
    },
  };
  return { client, calls };
}

describe("hashApiKey", () => {
  it("produces a deterministic 64-char hex SHA-256", () => {
    const h = hashApiKey("hnp_test_token");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).toBe(hashApiKey("hnp_test_token"));
  });

  it("differs for different inputs", () => {
    expect(hashApiKey("a")).not.toBe(hashApiKey("b"));
  });
});

describe("extractBearerToken", () => {
  it("parses 'Bearer <token>' (case-insensitive)", () => {
    expect(extractBearerToken("Bearer abc123")).toBe("abc123");
    expect(extractBearerToken("bearer abc123")).toBe("abc123");
    expect(extractBearerToken("  Bearer  abc123  ")).toBe("abc123");
  });

  it("returns null for missing or malformed headers", () => {
    expect(extractBearerToken(undefined)).toBeNull();
    expect(extractBearerToken("")).toBeNull();
    expect(extractBearerToken("Token abc")).toBeNull();
    expect(extractBearerToken("Bearer ")).toBeNull();
  });
});

describe("lookupApiKey", () => {
  it("hashes the bearer and joins users for caller info", async () => {
    const { client, calls } = recordingClient([
      {
        api_key_id: "k1",
        user_id: "u1",
        telegram_user_id: 7777,
        tier: "pulse-pro",
        threshold_pct: 70,
      },
    ]);
    const caller = await lookupApiKey(client, "hnp_test_token");
    expect(caller).toEqual({
      apiKeyId: "k1",
      userId: "u1",
      telegramUserId: 7777,
      tier: "pulse-pro",
      thresholdPct: 70,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].text).toMatch(/FROM api_keys/i);
    expect(calls[0].text).toMatch(/revoked_at IS NULL/i);
    expect(calls[0].params).toEqual([hashApiKey("hnp_test_token")]);
  });

  it("returns null when the key is unknown", async () => {
    const { client } = recordingClient([]);
    expect(await lookupApiKey(client, "missing")).toBeNull();
  });

  it("returns null for an empty string token", async () => {
    const { client, calls } = recordingClient([]);
    expect(await lookupApiKey(client, "   ")).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe("ApiRateLimiter", () => {
  it("allows up to limit requests in the window then blocks", () => {
    let now = 1_000_000;
    const lim = new ApiRateLimiter({
      limit: 3,
      windowMs: 60_000,
      now: () => now,
    });
    expect(lim.check("k").allowed).toBe(true);
    expect(lim.check("k").allowed).toBe(true);
    expect(lim.check("k").allowed).toBe(true);
    const blocked = lim.check("k");
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
    expect(blocked.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it("releases capacity after the window passes", () => {
    let now = 1_000_000;
    const lim = new ApiRateLimiter({
      limit: 2,
      windowMs: 1000,
      now: () => now,
    });
    expect(lim.check("k").allowed).toBe(true);
    expect(lim.check("k").allowed).toBe(true);
    expect(lim.check("k").allowed).toBe(false);
    now += 1500;
    expect(lim.check("k").allowed).toBe(true);
  });

  it("isolates buckets by key", () => {
    let now = 1_000_000;
    const lim = new ApiRateLimiter({
      limit: 1,
      windowMs: 60_000,
      now: () => now,
    });
    expect(lim.check("a").allowed).toBe(true);
    expect(lim.check("a").allowed).toBe(false);
    expect(lim.check("b").allowed).toBe(true);
  });

  it("defaults to 60/min", () => {
    let now = 0;
    const lim = new ApiRateLimiter({ now: () => now });
    for (let i = 0; i < 60; i += 1) {
      expect(lim.check("k").allowed).toBe(true);
    }
    expect(lim.check("k").allowed).toBe(false);
  });
});
