/**
 * pulse-pro v1 REST API routes (Spec.md §6 pulse-pro tier).
 *
 * All routes live under /v1, gated by the bearer-token auth middleware
 * from ./keys.ts. Endpoints are read-only and return JSON suitable for
 * downstream automation (Zapier, custom dashboards, scoring backtests).
 *
 *   GET /v1/items/:id           — single item with its most recent snapshot
 *   GET /v1/items?domain=X      — recent items for a domain (newest first)
 *   GET /v1/me                  — caller's account summary (tier, threshold)
 */

import { Router, type Router as ExpressRouter } from "express";
import {
  ApiRateLimiter,
  makeApiAuthMiddleware,
  type ApiAuthQueryClient,
  type AuthedRequest,
} from "./keys.js";

export interface ApiRoutesQueryClient extends ApiAuthQueryClient {}

export interface ApiRoutesOptions {
  client: ApiRoutesQueryClient;
  rateLimiter?: ApiRateLimiter;
  /** Default: 50, capped at 200. */
  defaultDomainLimit?: number;
  maxDomainLimit?: number;
  now?: () => Date;
}

interface ItemRow {
  id: number | string;
  by: string | null;
  title: string | null;
  url: string | null;
  domain: string | null;
  posted_at: Date | string;
  first_seen_at: Date | string;
  reached_front_page: boolean | null;
  reached_front_page_at: Date | string | null;
  [key: string]: unknown;
}

interface SnapshotRow {
  taken_at: Date | string;
  rank: number | string | null;
  score: number | string | null;
  comments: number | string | null;
  p_front_page_6h: number | string | null;
  delta_p_5min: number | string | null;
  [key: string]: unknown;
}

function asIsoString(value: Date | string | null): string | null {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function numOrNull(value: number | string | null | undefined): number | null {
  if (value == null) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function serializeItem(row: ItemRow, snapshot: SnapshotRow | null): unknown {
  return {
    id: Number(row.id),
    by: row.by,
    title: row.title,
    url: row.url,
    domain: row.domain,
    posted_at: asIsoString(row.posted_at),
    first_seen_at: asIsoString(row.first_seen_at),
    reached_front_page: row.reached_front_page,
    reached_front_page_at: asIsoString(row.reached_front_page_at),
    latest_snapshot: snapshot
      ? {
          taken_at: asIsoString(snapshot.taken_at),
          rank: numOrNull(snapshot.rank),
          score: numOrNull(snapshot.score),
          comments: numOrNull(snapshot.comments),
          p_front_page_6h: numOrNull(snapshot.p_front_page_6h),
          delta_p_5min: numOrNull(snapshot.delta_p_5min),
        }
      : null,
  };
}

export function createApiRouter(opts: ApiRoutesOptions): ExpressRouter {
  const client = opts.client;
  const router = Router();
  const auth = makeApiAuthMiddleware({
    client,
    rateLimiter: opts.rateLimiter,
    now: opts.now,
  });

  const defaultLimit = opts.defaultDomainLimit ?? 50;
  const maxLimit = opts.maxDomainLimit ?? 200;

  router.use(auth);

  router.get("/v1/me", (req: AuthedRequest, res) => {
    const caller = req.apiCaller!;
    res.json({
      user_id: caller.userId,
      telegram_user_id: caller.telegramUserId,
      tier: caller.tier,
      threshold_pct: caller.thresholdPct,
    });
  });

  router.get("/v1/items", async (req, res) => {
    const domainParam = req.query.domain;
    if (typeof domainParam !== "string" || domainParam.trim() === "") {
      res.status(400).json({ error: "domain query parameter is required" });
      return;
    }
    const domain = domainParam.trim().toLowerCase();
    const requestedLimit = Number(req.query.limit ?? defaultLimit);
    const limit =
      Number.isFinite(requestedLimit) && requestedLimit > 0
        ? Math.min(Math.floor(requestedLimit), maxLimit)
        : defaultLimit;

    try {
      const itemsRes = await client.query<ItemRow>(
        `SELECT id, by, title, url, domain, posted_at, first_seen_at,
                reached_front_page, reached_front_page_at
           FROM items
          WHERE domain = $1
          ORDER BY first_seen_at DESC
          LIMIT $2`,
        [domain, limit],
      );

      const ids = itemsRes.rows.map((r) => Number(r.id));
      const snapshotByItem = new Map<number, SnapshotRow>();
      if (ids.length > 0) {
        const snapsRes = await client.query<SnapshotRow & { item_id: number | string }>(
          `SELECT DISTINCT ON (item_id)
                  item_id, taken_at, rank, score, comments,
                  p_front_page_6h, delta_p_5min
             FROM item_snapshots
            WHERE item_id = ANY($1::int[])
            ORDER BY item_id, taken_at DESC`,
          [ids],
        );
        for (const s of snapsRes.rows) {
          snapshotByItem.set(Number(s.item_id), s);
        }
      }

      res.json({
        domain,
        count: itemsRes.rows.length,
        items: itemsRes.rows.map((row) =>
          serializeItem(row, snapshotByItem.get(Number(row.id)) ?? null),
        ),
      });
    } catch {
      res.status(500).json({ error: "items query failed" });
    }
  });

  router.get("/v1/items/:id", async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "id must be a positive integer" });
      return;
    }
    try {
      const itemRes = await client.query<ItemRow>(
        `SELECT id, by, title, url, domain, posted_at, first_seen_at,
                reached_front_page, reached_front_page_at
           FROM items
          WHERE id = $1
          LIMIT 1`,
        [id],
      );
      if (itemRes.rows.length === 0) {
        res.status(404).json({ error: "item not found" });
        return;
      }
      const item = itemRes.rows[0]!;
      const snapRes = await client.query<SnapshotRow>(
        `SELECT taken_at, rank, score, comments, p_front_page_6h, delta_p_5min
           FROM item_snapshots
          WHERE item_id = $1
          ORDER BY taken_at DESC
          LIMIT 1`,
        [id],
      );
      res.json(serializeItem(item, snapRes.rows[0] ?? null));
    } catch {
      res.status(500).json({ error: "item query failed" });
    }
  });

  return router;
}
