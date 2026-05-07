import type { WatchWithUser } from "../db/watches.js";

export type AlertType = "threshold" | "acceleration" | "submitted";

export const ACCELERATION_DELTA_THRESHOLD = 0.15;
export const FREE_TIER_FORCED_THRESHOLD_PCT = 80;

export interface SnapshotMatchInput {
  itemId: number;
  itemBy: string | null;
  itemDomain: string | null;
  pFrontPage6h: number;
  deltaP5min: number;
  /** True only on the very first snapshot for this item — used for 'submitted' alerts. */
  isFirstSnapshot: boolean;
}

export interface MatchedAlert {
  user_id: string;
  item_id: number;
  alert_type: AlertType;
  watch_id: string;
  watch_type: WatchWithUser["watch_type"];
  watch_value: string;
  user_tier: WatchWithUser["user_tier"];
  payload: AlertPayload;
}

export interface AlertPayload {
  watch_type: WatchWithUser["watch_type"];
  watch_value: string;
  p_front_page_6h: number;
  delta_p_5min: number;
  threshold_pct: number;
}

function watchMatchesItem(
  watch: WatchWithUser,
  snap: SnapshotMatchInput,
): boolean {
  switch (watch.watch_type) {
    case "item":
      return watch.watch_value === String(snap.itemId);
    case "domain":
      return snap.itemDomain != null && watch.watch_value === snap.itemDomain;
    case "submitter":
      return snap.itemBy != null && watch.watch_value === snap.itemBy;
    default:
      return false;
  }
}

function effectiveThresholdPct(watch: WatchWithUser): number {
  if (watch.user_tier === "free") {
    return Math.max(watch.user_threshold_pct, FREE_TIER_FORCED_THRESHOLD_PCT);
  }
  return watch.user_threshold_pct;
}

export function matchAlerts(
  snapshot: SnapshotMatchInput,
  watches: ReadonlyArray<WatchWithUser>,
): MatchedAlert[] {
  const out: MatchedAlert[] = [];
  // A user can have multiple watches that all match the same item; we still
  // emit at most one alert per (user, item, alert_type) per snapshot. The
  // first watch that produces a given (user, alert_type) wins.
  const seen = new Set<string>();

  const accept = (watch: WatchWithUser, alertType: AlertType): void => {
    const key = `${watch.user_id}|${alertType}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      user_id: watch.user_id,
      item_id: snapshot.itemId,
      alert_type: alertType,
      watch_id: watch.id,
      watch_type: watch.watch_type,
      watch_value: watch.watch_value,
      user_tier: watch.user_tier,
      payload: {
        watch_type: watch.watch_type,
        watch_value: watch.watch_value,
        p_front_page_6h: snapshot.pFrontPage6h,
        delta_p_5min: snapshot.deltaP5min,
        threshold_pct: effectiveThresholdPct(watch),
      },
    });
  };

  for (const watch of watches) {
    if (!watchMatchesItem(watch, snapshot)) continue;

    // 'submitted' fires only on the first snapshot of a watched submitter's item.
    if (
      watch.watch_type === "submitter" &&
      snapshot.isFirstSnapshot &&
      snapshot.itemBy != null
    ) {
      accept(watch, "submitted");
    }

    const thresholdPct = effectiveThresholdPct(watch);
    if (snapshot.pFrontPage6h * 100 >= thresholdPct) {
      accept(watch, "threshold");
    }

    // Acceleration alerts are a paid-tier feature per Spec.md ("acceleration alerts" is in `pulse`).
    if (
      watch.user_tier !== "free" &&
      snapshot.deltaP5min > ACCELERATION_DELTA_THRESHOLD
    ) {
      accept(watch, "acceleration");
    }
  }

  return out;
}
