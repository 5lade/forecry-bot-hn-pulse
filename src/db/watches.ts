import type { ItemsQueryClient } from "./items.js";

export type WatchType = "item" | "domain" | "submitter";
export type UserTier = "free" | "pulse" | "pulse-pro" | "canceled";

export interface WatchWithUser {
  id: string;
  user_id: string;
  watch_type: WatchType;
  watch_value: string;
  user_tier: UserTier;
  user_threshold_pct: number;
}

interface WatchRowDb {
  id: string;
  user_id: string;
  watch_type: string;
  watch_value: string;
  user_tier: string;
  user_threshold_pct: number | string;
  [key: string]: unknown;
}

function normalizeRow(row: WatchRowDb): WatchWithUser {
  return {
    id: row.id,
    user_id: row.user_id,
    watch_type: row.watch_type as WatchType,
    watch_value: row.watch_value,
    user_tier: row.user_tier as UserTier,
    user_threshold_pct: Number(row.user_threshold_pct),
  };
}

const SELECT_WATCHES_BASE = `
  SELECT w.id, w.user_id, w.watch_type, w.watch_value,
         u.tier AS user_tier, u.threshold_pct AS user_threshold_pct
    FROM watches w
    JOIN users u ON u.id = w.user_id
`;

export async function listWatchesByItem(
  client: ItemsQueryClient,
  itemId: number,
): Promise<WatchWithUser[]> {
  const res = await client.query<WatchRowDb>(
    `${SELECT_WATCHES_BASE}
     WHERE w.watch_type = 'item' AND w.watch_value = $1`,
    [String(itemId)],
  );
  return res.rows.map(normalizeRow);
}

export async function listWatchesByDomain(
  client: ItemsQueryClient,
  domain: string,
): Promise<WatchWithUser[]> {
  const res = await client.query<WatchRowDb>(
    `${SELECT_WATCHES_BASE}
     WHERE w.watch_type = 'domain' AND w.watch_value = $1`,
    [domain],
  );
  return res.rows.map(normalizeRow);
}

export async function listWatchesBySubmitter(
  client: ItemsQueryClient,
  submitter: string,
): Promise<WatchWithUser[]> {
  const res = await client.query<WatchRowDb>(
    `${SELECT_WATCHES_BASE}
     WHERE w.watch_type = 'submitter' AND w.watch_value = $1`,
    [submitter],
  );
  return res.rows.map(normalizeRow);
}

export async function countActiveWatches(
  client: ItemsQueryClient,
): Promise<number> {
  const res = await client.query<{ count: number | string }>(
    `SELECT COUNT(*)::int AS count FROM watches`,
  );
  return Number(res.rows[0]?.count ?? 0);
}

export async function listMatchingWatches(
  client: ItemsQueryClient,
  args: {
    itemId: number;
    domain: string | null;
    submitter: string | null;
  },
): Promise<WatchWithUser[]> {
  const out: WatchWithUser[] = [];
  out.push(...(await listWatchesByItem(client, args.itemId)));
  if (args.domain) {
    out.push(...(await listWatchesByDomain(client, args.domain)));
  }
  if (args.submitter) {
    out.push(...(await listWatchesBySubmitter(client, args.submitter)));
  }
  return out;
}
