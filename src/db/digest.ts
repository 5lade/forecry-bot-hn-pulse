import type { ItemsQueryClient } from "./items.js";

export type DigestQueryClient = ItemsQueryClient;

export interface DigestEligibleUser {
  id: string;
  telegram_user_id: number;
  threshold_pct: number;
  tier: string;
}

export interface DigestTrackedItem {
  item_id: number;
  title: string | null;
  url: string | null;
  domain: string | null;
  by: string | null;
  first_seen_at: Date;
  predicted_p: number | null;
  final_rank: number | null;
  final_p: number | null;
}

/**
 * Eligible users for the daily digest: opted in AND on a paid tier.
 * Free-tier and canceled users are skipped per Spec.md (digest is a `pulse`+ feature).
 */
export async function listDigestEligibleUsers(
  client: DigestQueryClient,
): Promise<DigestEligibleUser[]> {
  const res = await client.query<{
    id: string;
    telegram_user_id: number | string;
    threshold_pct: number | string;
    tier: string;
  }>(
    `SELECT id, telegram_user_id, threshold_pct, tier
       FROM users
      WHERE digest_opt_in = TRUE
        AND tier IN ('pulse', 'pulse-pro')
      ORDER BY id`,
  );
  return res.rows.map((r) => ({
    id: r.id,
    telegram_user_id: Number(r.telegram_user_id),
    threshold_pct: Number(r.threshold_pct),
    tier: r.tier,
  }));
}

/**
 * Returns all items first seen in [fromUtc, toUtc) that match any of the user's
 * watches (by item id, domain, or submitter), enriched with the model's first
 * predicted probability and final rank/probability from item_snapshots.
 */
export async function listYesterdayTrackedItems(
  client: DigestQueryClient,
  args: { userId: string; fromUtc: Date; toUtc: Date },
): Promise<DigestTrackedItem[]> {
  const res = await client.query<{
    item_id: number;
    title: string | null;
    url: string | null;
    domain: string | null;
    by: string | null;
    first_seen_at: Date | string;
    predicted_p: number | string | null;
    final_rank: number | string | null;
    final_p: number | string | null;
  }>(
    `WITH user_items AS (
       SELECT DISTINCT i.id, i.title, i.url, i.domain, i.by, i.first_seen_at
         FROM items i
         JOIN watches w ON w.user_id = $1
                       AND (
                         (w.watch_type = 'item'      AND w.watch_value = i.id::text) OR
                         (w.watch_type = 'domain'    AND w.watch_value = i.domain) OR
                         (w.watch_type = 'submitter' AND w.watch_value = i.by)
                       )
        WHERE i.first_seen_at >= $2 AND i.first_seen_at < $3
     ),
     first_snap AS (
       SELECT DISTINCT ON (s.item_id)
              s.item_id, s.p_front_page_6h AS predicted_p
         FROM item_snapshots s
         JOIN user_items u ON u.id = s.item_id
        ORDER BY s.item_id, s.taken_at ASC
     ),
     last_snap AS (
       SELECT DISTINCT ON (s.item_id)
              s.item_id,
              s.rank AS final_rank,
              s.p_front_page_6h AS final_p
         FROM item_snapshots s
         JOIN user_items u ON u.id = s.item_id
        ORDER BY s.item_id, s.taken_at DESC
     )
     SELECT u.id           AS item_id,
            u.title,
            u.url,
            u.domain,
            u.by,
            u.first_seen_at,
            fs.predicted_p,
            ls.final_rank,
            ls.final_p
       FROM user_items u
       LEFT JOIN first_snap fs ON fs.item_id = u.id
       LEFT JOIN last_snap  ls ON ls.item_id = u.id
      ORDER BY u.first_seen_at ASC, u.id ASC`,
    [args.userId, args.fromUtc, args.toUtc],
  );

  return res.rows.map((r) => ({
    item_id: Number(r.item_id),
    title: r.title,
    url: r.url,
    domain: r.domain,
    by: r.by,
    first_seen_at:
      r.first_seen_at instanceof Date
        ? r.first_seen_at
        : new Date(r.first_seen_at),
    predicted_p: r.predicted_p == null ? null : Number(r.predicted_p),
    final_rank: r.final_rank == null ? null : Number(r.final_rank),
    final_p: r.final_p == null ? null : Number(r.final_p),
  }));
}

/**
 * Atomically claim the (user_id, digest_date) slot. Returns true if this call
 * inserted the row (caller should send), false if a row already existed
 * (caller should skip — already sent today).
 */
export async function tryClaimDigestRun(
  client: DigestQueryClient,
  args: { userId: string; digestDate: string },
): Promise<boolean> {
  const res = await client.query<{ user_id: string }>(
    `INSERT INTO digest_runs (user_id, digest_date)
     VALUES ($1, $2)
     ON CONFLICT (user_id, digest_date) DO NOTHING
     RETURNING user_id`,
    [args.userId, args.digestDate],
  );
  return res.rows.length > 0;
}
