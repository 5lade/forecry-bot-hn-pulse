import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { ApiRateLimiter, hashApiKey } from "../keys.js";
import { createApiRouter } from "../routes.js";
import express from "express";

interface QueryHandler {
  (text: string, params?: ReadonlyArray<unknown>): Promise<unknown[]>;
}

function fakeClient(handler: QueryHandler) {
  return {
    async query<T extends Record<string, unknown>>(
      text: string,
      params?: ReadonlyArray<unknown>,
    ): Promise<{ rows: T[] }> {
      const rows = (await handler(text, params)) as T[];
      return { rows };
    },
  };
}

const TOKEN = "hnp_test_token_xyz";
const HASH = hashApiKey(TOKEN);

const callerRow = {
  api_key_id: "00000000-0000-0000-0000-00000000aaaa",
  user_id: "00000000-0000-0000-0000-00000000bbbb",
  telegram_user_id: 12345,
  tier: "pulse-pro",
  threshold_pct: 70,
};

const itemRow = {
  id: 42,
  by: "alice",
  title: "Show HN: thing",
  url: "https://example.com/x",
  domain: "example.com",
  posted_at: new Date("2026-05-01T10:00:00Z"),
  first_seen_at: new Date("2026-05-01T10:00:30Z"),
  reached_front_page: true,
  reached_front_page_at: new Date("2026-05-01T10:35:00Z"),
};

const snapshotRow = {
  taken_at: new Date("2026-05-01T11:00:00Z"),
  rank: 12,
  score: 88,
  comments: 14,
  p_front_page_6h: 0.82,
  delta_p_5min: 0.04,
};

function makeQueryHandler(opts: {
  itemsByDomain?: Record<string, typeof itemRow[]>;
  itemsById?: Record<number, typeof itemRow>;
  /** Map item_id -> snapshot row (omit to return no snapshot). */
  latestSnapByItem?: Record<number, typeof snapshotRow>;
  /** Optional override for the api_keys lookup. */
  authRow?: typeof callerRow | null;
  onUpdate?: () => void;
}): QueryHandler {
  const auth = opts.authRow === undefined ? callerRow : opts.authRow;
  return async (text, params) => {
    if (/FROM api_keys/i.test(text)) {
      const givenHash = (params ?? [])[0];
      if (auth && givenHash === HASH) return [auth];
      return [];
    }
    if (/^UPDATE api_keys SET last_used_at/i.test(text)) {
      opts.onUpdate?.();
      return [];
    }
    if (/FROM items/i.test(text) && /WHERE domain/i.test(text)) {
      const domain = String((params ?? [])[0]);
      return opts.itemsByDomain?.[domain] ?? [];
    }
    if (/FROM items/i.test(text) && /WHERE id/i.test(text)) {
      const id = Number((params ?? [])[0]);
      const row = opts.itemsById?.[id];
      return row ? [row] : [];
    }
    if (/FROM item_snapshots/i.test(text)) {
      // Either single-id (params=[id]) or ANY array (params=[ids[]]).
      const p0 = (params ?? [])[0];
      if (Array.isArray(p0)) {
        return p0
          .map((id) => {
            const snap = opts.latestSnapByItem?.[Number(id)];
            return snap ? { item_id: Number(id), ...snap } : null;
          })
          .filter(Boolean) as unknown[];
      }
      const id = Number(p0);
      const snap = opts.latestSnapByItem?.[id];
      return snap ? [snap] : [];
    }
    throw new Error(`unexpected query: ${text}`);
  };
}

interface ServerCtx {
  port: number;
  rateLimiter: ApiRateLimiter;
}

async function withApi<T>(
  handler: QueryHandler,
  fn: (ctx: ServerCtx) => Promise<T>,
  rate?: { limit?: number; windowMs?: number; now?: () => number },
): Promise<T> {
  const app = express();
  const rateLimiter = new ApiRateLimiter({
    limit: rate?.limit ?? 60,
    windowMs: rate?.windowMs ?? 60_000,
    now: rate?.now,
  });
  app.use(
    createApiRouter({
      client: fakeClient(handler),
      rateLimiter,
    }),
  );
  const server = app.listen(0);
  try {
    await new Promise<void>((r) => server.once("listening", r));
    const port = (server.address() as AddressInfo).port;
    return await fn({ port, rateLimiter });
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

describe("auth", () => {
  it("returns 401 when the bearer token is missing", async () => {
    await withApi(makeQueryHandler({}), async ({ port }) => {
      const res = await fetch(`http://127.0.0.1:${port}/v1/me`);
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/missing|invalid/i);
      expect(res.headers.get("www-authenticate")).toMatch(/Bearer/i);
    });
  });

  it("returns 401 when the bearer token is invalid", async () => {
    await withApi(makeQueryHandler({}), async ({ port }) => {
      const res = await fetch(`http://127.0.0.1:${port}/v1/me`, {
        headers: { authorization: "Bearer wrong-token" },
      });
      expect(res.status).toBe(401);
    });
  });

  it("returns 401 for non-Bearer Authorization schemes", async () => {
    await withApi(makeQueryHandler({}), async ({ port }) => {
      const res = await fetch(`http://127.0.0.1:${port}/v1/me`, {
        headers: { authorization: `Token ${TOKEN}` },
      });
      expect(res.status).toBe(401);
    });
  });
});

describe("rate limiting", () => {
  it("returns 429 with Retry-After once the per-key budget is spent", async () => {
    let now = 0;
    await withApi(
      makeQueryHandler({}),
      async ({ port }) => {
        const url = `http://127.0.0.1:${port}/v1/me`;
        const headers = { authorization: `Bearer ${TOKEN}` };
        // Three OK
        for (let i = 0; i < 3; i += 1) {
          const r = await fetch(url, { headers });
          expect(r.status).toBe(200);
          await r.text();
        }
        // Fourth should be rate-limited
        const blocked = await fetch(url, { headers });
        expect(blocked.status).toBe(429);
        expect(blocked.headers.get("retry-after")).toBeTruthy();
        const body = (await blocked.json()) as {
          error: string;
          retry_after_seconds: number;
        };
        expect(body.error).toMatch(/rate limit/i);
        expect(body.retry_after_seconds).toBeGreaterThan(0);
      },
      { limit: 3, windowMs: 60_000, now: () => now },
    );
  });
});

describe("GET /v1/me", () => {
  it("returns the caller's account summary", async () => {
    await withApi(makeQueryHandler({}), async ({ port }) => {
      const res = await fetch(`http://127.0.0.1:${port}/v1/me`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toEqual({
        user_id: callerRow.user_id,
        telegram_user_id: callerRow.telegram_user_id,
        tier: "pulse-pro",
        threshold_pct: 70,
      });
    });
  });
});

describe("GET /v1/items/:id", () => {
  it("returns the item plus its most recent snapshot", async () => {
    await withApi(
      makeQueryHandler({
        itemsById: { 42: itemRow },
        latestSnapByItem: { 42: snapshotRow },
      }),
      async ({ port }) => {
        const res = await fetch(`http://127.0.0.1:${port}/v1/items/42`, {
          headers: { authorization: `Bearer ${TOKEN}` },
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          id: number;
          domain: string;
          latest_snapshot: { rank: number; p_front_page_6h: number } | null;
        };
        expect(body.id).toBe(42);
        expect(body.domain).toBe("example.com");
        expect(body.latest_snapshot?.rank).toBe(12);
        expect(body.latest_snapshot?.p_front_page_6h).toBeCloseTo(0.82, 5);
      },
    );
  });

  it("returns 404 when the item does not exist", async () => {
    await withApi(makeQueryHandler({ itemsById: {} }), async ({ port }) => {
      const res = await fetch(`http://127.0.0.1:${port}/v1/items/9999`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.status).toBe(404);
    });
  });

  it("returns 400 when id is not a positive integer", async () => {
    await withApi(makeQueryHandler({}), async ({ port }) => {
      const res = await fetch(`http://127.0.0.1:${port}/v1/items/abc`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.status).toBe(400);
    });
  });
});

describe("GET /v1/items?domain=", () => {
  it("returns items for the given domain with their latest snapshots", async () => {
    const second = { ...itemRow, id: 43, title: "Item 43" };
    await withApi(
      makeQueryHandler({
        itemsByDomain: { "example.com": [itemRow, second] },
        latestSnapByItem: { 42: snapshotRow },
      }),
      async ({ port }) => {
        const res = await fetch(
          `http://127.0.0.1:${port}/v1/items?domain=example.com`,
          { headers: { authorization: `Bearer ${TOKEN}` } },
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          domain: string;
          count: number;
          items: { id: number; latest_snapshot: unknown }[];
        };
        expect(body.domain).toBe("example.com");
        expect(body.count).toBe(2);
        expect(body.items.map((i) => i.id)).toEqual([42, 43]);
        expect(body.items[0]!.latest_snapshot).toBeTruthy();
        expect(body.items[1]!.latest_snapshot).toBeNull();
      },
    );
  });

  it("normalizes the domain to lowercase before query", async () => {
    let seenDomain: string | null = null;
    await withApi(
      async (text, params) => {
        if (/FROM api_keys/i.test(text)) return [callerRow];
        if (/^UPDATE api_keys/i.test(text)) return [];
        if (/FROM items/i.test(text) && /WHERE domain/i.test(text)) {
          seenDomain = String((params ?? [])[0]);
          return [];
        }
        return [];
      },
      async ({ port }) => {
        const res = await fetch(
          `http://127.0.0.1:${port}/v1/items?domain=Example.COM`,
          { headers: { authorization: `Bearer ${TOKEN}` } },
        );
        expect(res.status).toBe(200);
        expect(seenDomain).toBe("example.com");
      },
    );
  });

  it("returns 400 when domain query parameter is missing", async () => {
    await withApi(makeQueryHandler({}), async ({ port }) => {
      const res = await fetch(`http://127.0.0.1:${port}/v1/items`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.status).toBe(400);
    });
  });
});
