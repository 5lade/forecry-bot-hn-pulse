import { randomUUID } from "node:crypto";
import type { ItemsQueryClient } from "../db/items.js";
import type { UserTier, WatchType } from "../db/watches.js";

export type BotQueryClient = ItemsQueryClient;

export interface UserRow {
  id: string;
  telegram_user_id: string | number;
  tier: UserTier;
  threshold_pct: number;
  digest_opt_in: boolean;
  stripe_customer_id: string | null;
}

export interface WatchRow {
  id: string;
  user_id: string;
  watch_type: WatchType;
  watch_value: string;
  created_at: Date;
}

export interface AlertRow {
  id: string;
  item_id: number;
  alert_type: string;
  matched_at: Date | null;
  payload: unknown;
}

export const FREE_TIER_WATCH_LIMIT = 2;

interface UserRowDb extends Record<string, unknown> {
  id: string;
  telegram_user_id: string | number;
  tier: string;
  threshold_pct: number | string;
  digest_opt_in: boolean;
  stripe_customer_id: string | null;
}

function normalizeUser(row: UserRowDb): UserRow {
  return {
    id: row.id,
    telegram_user_id: row.telegram_user_id,
    tier: row.tier as UserTier,
    threshold_pct: Number(row.threshold_pct),
    digest_opt_in: row.digest_opt_in,
    stripe_customer_id: row.stripe_customer_id,
  };
}

export async function getUserByTelegramId(
  client: BotQueryClient,
  telegramUserId: number,
): Promise<UserRow | null> {
  const res = await client.query<UserRowDb>(
    `SELECT id, telegram_user_id, tier, threshold_pct, digest_opt_in, stripe_customer_id
       FROM users
      WHERE telegram_user_id = $1
      LIMIT 1`,
    [telegramUserId],
  );
  if (res.rows.length === 0) return null;
  return normalizeUser(res.rows[0]!);
}

/**
 * /start is idempotent: insert if missing, return the row either way.
 */
export async function upsertUserByTelegramId(
  client: BotQueryClient,
  telegramUserId: number,
  generateId: () => string = () => randomUUID(),
): Promise<UserRow> {
  const id = generateId();
  const res = await client.query<UserRowDb>(
    `INSERT INTO users (id, telegram_user_id)
     VALUES ($1, $2)
     ON CONFLICT (telegram_user_id) DO UPDATE
       SET telegram_user_id = EXCLUDED.telegram_user_id
     RETURNING id, telegram_user_id, tier, threshold_pct, digest_opt_in, stripe_customer_id`,
    [id, telegramUserId],
  );
  return normalizeUser(res.rows[0]!);
}

export async function listUserWatches(
  client: BotQueryClient,
  userId: string,
): Promise<WatchRow[]> {
  const res = await client.query<{
    id: string;
    user_id: string;
    watch_type: string;
    watch_value: string;
    created_at: Date | string;
  }>(
    `SELECT id, user_id, watch_type, watch_value, created_at
       FROM watches
      WHERE user_id = $1
      ORDER BY created_at ASC`,
    [userId],
  );
  return res.rows.map((r) => ({
    id: r.id,
    user_id: r.user_id,
    watch_type: r.watch_type as WatchType,
    watch_value: r.watch_value,
    created_at:
      r.created_at instanceof Date ? r.created_at : new Date(r.created_at),
  }));
}

export async function countUserWatches(
  client: BotQueryClient,
  userId: string,
): Promise<number> {
  const res = await client.query<{ count: number | string }>(
    `SELECT COUNT(*)::int AS count FROM watches WHERE user_id = $1`,
    [userId],
  );
  return Number(res.rows[0]?.count ?? 0);
}

export async function insertWatch(
  client: BotQueryClient,
  args: {
    userId: string;
    watchType: WatchType;
    watchValue: string;
    generateId?: () => string;
  },
): Promise<WatchRow> {
  const id = (args.generateId ?? (() => randomUUID()))();
  const res = await client.query<{
    id: string;
    user_id: string;
    watch_type: string;
    watch_value: string;
    created_at: Date | string;
  }>(
    `INSERT INTO watches (id, user_id, watch_type, watch_value)
     VALUES ($1, $2, $3, $4)
     RETURNING id, user_id, watch_type, watch_value, created_at`,
    [id, args.userId, args.watchType, args.watchValue],
  );
  const row = res.rows[0]!;
  return {
    id: row.id,
    user_id: row.user_id,
    watch_type: row.watch_type as WatchType,
    watch_value: row.watch_value,
    created_at:
      row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
  };
}

export async function deleteWatchById(
  client: BotQueryClient,
  args: { watchId: string; userId: string },
): Promise<boolean> {
  const res = await client.query<{ id: string }>(
    `DELETE FROM watches WHERE id = $1 AND user_id = $2 RETURNING id`,
    [args.watchId, args.userId],
  );
  return res.rows.length > 0;
}

export async function updateUserThreshold(
  client: BotQueryClient,
  userId: string,
  thresholdPct: number,
): Promise<void> {
  await client.query(
    `UPDATE users SET threshold_pct = $2 WHERE id = $1`,
    [userId, thresholdPct],
  );
}

export async function toggleUserDigest(
  client: BotQueryClient,
  userId: string,
): Promise<boolean> {
  const res = await client.query<{ digest_opt_in: boolean }>(
    `UPDATE users SET digest_opt_in = NOT digest_opt_in
      WHERE id = $1
      RETURNING digest_opt_in`,
    [userId],
  );
  return Boolean(res.rows[0]?.digest_opt_in);
}

export async function setUserStripeCustomerId(
  client: BotQueryClient,
  userId: string,
  customerId: string,
): Promise<void> {
  await client.query(
    `UPDATE users SET stripe_customer_id = $2 WHERE id = $1`,
    [userId, customerId],
  );
}

export async function listRecentAlerts(
  client: BotQueryClient,
  userId: string,
  limit = 5,
): Promise<AlertRow[]> {
  const res = await client.query<{
    id: string;
    item_id: number;
    alert_type: string;
    matched_at: Date | string | null;
    payload: unknown;
  }>(
    `SELECT id, item_id, alert_type, matched_at, payload
       FROM alerts
      WHERE user_id = $1
      ORDER BY sent_at DESC
      LIMIT $2`,
    [userId, limit],
  );
  return res.rows.map((r) => ({
    id: r.id,
    item_id: r.item_id,
    alert_type: r.alert_type,
    matched_at:
      r.matched_at == null
        ? null
        : r.matched_at instanceof Date
          ? r.matched_at
          : new Date(r.matched_at),
    payload: r.payload,
  }));
}
