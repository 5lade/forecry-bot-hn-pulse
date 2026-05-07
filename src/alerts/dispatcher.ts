import { randomUUID } from "node:crypto";
import type { ItemsQueryClient } from "../db/items.js";
import { listMatchingWatches } from "../db/watches.js";
import { childLogger } from "../log.js";
import {
  matchAlerts,
  type MatchedAlert,
  type SnapshotMatchInput,
} from "./match.js";
import type { AlertSender } from "./sender.js";

export const DEFAULT_DEDUP_WINDOW_MS = 30 * 60_000;

export interface DispatchResult {
  matched: MatchedAlert[];
  inserted: MatchedAlert[];
  delivered: MatchedAlert[];
  suppressedByDedup: MatchedAlert[];
  failedDeliveries: Array<{ alert: MatchedAlert; error: unknown }>;
}

export interface DispatcherDeps {
  client: ItemsQueryClient;
  sender: AlertSender;
  now?: () => Date;
  dedupWindowMs?: number;
  generateId?: () => string;
  log?: (msg: string) => void;
  onError?: (err: unknown, label: string) => void;
}

export interface SnapshotForDispatch extends SnapshotMatchInput {}

async function hasRecentAlert(
  client: ItemsQueryClient,
  alert: MatchedAlert,
  cutoff: Date,
): Promise<boolean> {
  const res = await client.query<{ exists: boolean }>(
    `SELECT 1 AS exists
       FROM alerts
      WHERE user_id = $1
        AND item_id = $2
        AND alert_type = $3
        AND matched_at IS NOT NULL
        AND matched_at >= $4
      LIMIT 1`,
    [alert.user_id, alert.item_id, alert.alert_type, cutoff],
  );
  return res.rows.length > 0;
}

async function insertAlertRow(
  client: ItemsQueryClient,
  args: {
    id: string;
    user_id: string;
    item_id: number;
    alert_type: string;
    matched_at: Date;
    payload: unknown;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO alerts (id, user_id, item_id, alert_type, matched_at, payload)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      args.id,
      args.user_id,
      args.item_id,
      args.alert_type,
      args.matched_at,
      JSON.stringify(args.payload),
    ],
  );
}

async function markDelivered(
  client: ItemsQueryClient,
  alertId: string,
  deliveredAt: Date,
): Promise<void> {
  await client.query(
    `UPDATE alerts SET delivered_at = $2 WHERE id = $1`,
    [alertId, deliveredAt],
  );
}

export async function dispatchAlertsForSnapshot(
  deps: DispatcherDeps,
  snapshot: SnapshotForDispatch,
): Promise<DispatchResult> {
  const now = deps.now ?? (() => new Date());
  const dedupWindowMs = deps.dedupWindowMs ?? DEFAULT_DEDUP_WINDOW_MS;
  const generateId = deps.generateId ?? (() => randomUUID());
  const itemLog = childLogger({ component: "alerts", item_id: snapshot.itemId });
  const log = deps.log ?? ((msg: string) => itemLog.info(msg));

  const watches = await listMatchingWatches(deps.client, {
    itemId: snapshot.itemId,
    domain: snapshot.itemDomain,
    submitter: snapshot.itemBy,
  });

  const matched = matchAlerts(snapshot, watches);

  const result: DispatchResult = {
    matched,
    inserted: [],
    delivered: [],
    suppressedByDedup: [],
    failedDeliveries: [],
  };

  if (matched.length === 0) return result;

  const matchedAt = now();
  const cutoff = new Date(matchedAt.getTime() - dedupWindowMs);

  for (const alert of matched) {
    if (await hasRecentAlert(deps.client, alert, cutoff)) {
      result.suppressedByDedup.push(alert);
      continue;
    }

    const alertId = generateId();
    await insertAlertRow(deps.client, {
      id: alertId,
      user_id: alert.user_id,
      item_id: alert.item_id,
      alert_type: alert.alert_type,
      matched_at: matchedAt,
      payload: alert.payload,
    });
    result.inserted.push(alert);

    try {
      await deps.sender.send({
        alert_id: alertId,
        user_id: alert.user_id,
        item_id: alert.item_id,
        alert_type: alert.alert_type,
        payload: alert.payload,
      });
      const deliveredAt = now();
      await markDelivered(deps.client, alertId, deliveredAt);
      result.delivered.push(alert);
    } catch (err) {
      result.failedDeliveries.push({ alert, error: err });
      if (deps.onError) deps.onError(err, "alert-delivery");
    }
  }

  log(
    `[alerts] item=${snapshot.itemId} matched=${matched.length} ` +
      `inserted=${result.inserted.length} delivered=${result.delivered.length} ` +
      `suppressed=${result.suppressedByDedup.length} failed=${result.failedDeliveries.length}`,
  );
  return result;
}

/**
 * Adapter callback shape consumed by `scoreAndInsertSnapshot`. The scorer
 * fires this synchronously after a successful snapshot insert so the
 * dispatcher can react to the inserted snapshot.
 */
export type SnapshotInsertedHook = (
  snapshot: SnapshotForDispatch,
) => Promise<void> | void;

export function makeDispatcherHook(
  deps: DispatcherDeps,
): SnapshotInsertedHook {
  return async (snapshot: SnapshotForDispatch): Promise<void> => {
    try {
      await dispatchAlertsForSnapshot(deps, snapshot);
    } catch (err) {
      if (deps.onError) deps.onError(err, "alert-dispatch");
      else throw err;
    }
  };
}
