-- 0004_soak_views.sql
-- Helper views for bin/test-completion.sh acceptance probes (hn-pulse-p1-009).
-- Each view returns a single-row, single-column scalar so the bash script
-- can read it with psql -tA without parsing complex SQL inline.
--
-- NOTE on numbering: the ticket nominally targets `0002_soak_views.sql`, but
-- 0002_alerts.sql already exists in this branch (added by p1-005). Bumping
-- to 0004 keeps migrations append-only and ordering deterministic.
--
-- All statements are idempotent (CREATE OR REPLACE VIEW) so re-running the
-- migration on an existing database is safe.

-- Criterion 1: poller liveness — lag between NOW() and most recent
-- items.first_seen_at, in seconds. NULL when the items table is empty
-- (which is itself a fail signal, handled by the script).
CREATE OR REPLACE VIEW v_poller_lag AS
SELECT EXTRACT(EPOCH FROM (NOW() - MAX(first_seen_at)))::numeric AS lag_seconds
FROM items;

-- Criterion 2: snapshot freshness — percentage of tracked items (< 6h old)
-- that have at least one snapshot within the last 90 seconds.
CREATE OR REPLACE VIEW v_snapshot_freshness AS
WITH tracked AS (
  SELECT id FROM items WHERE first_seen_at > NOW() - INTERVAL '6 hours'
), fresh AS (
  SELECT DISTINCT item_id FROM item_snapshots
  WHERE taken_at > NOW() - INTERVAL '90 seconds'
)
SELECT COALESCE(
  ROUND(100.0 * COUNT(fresh.item_id) / NULLIF(COUNT(tracked.id), 0), 2),
  0
) AS freshness_pct
FROM tracked LEFT JOIN fresh ON fresh.item_id = tracked.id;

-- Criterion 3: scorer health — count of snapshots in the last hour that
-- have a NULL p_front_page_6h. Healthy = 0.
CREATE OR REPLACE VIEW v_scorer_null_count_1h AS
SELECT COUNT(*)::int AS null_count
FROM item_snapshots
WHERE taken_at > NOW() - INTERVAL '1 hour'
  AND p_front_page_6h IS NULL;

-- Criterion 4: alert delivery latency — p95 round-trip
-- (delivered_at - matched_at) in seconds for synthetic alerts in the last
-- 24 hours. Defaults to 9999 when no synthetic alerts exist (treated as
-- fail by the script so a silent dispatcher does not pass).
CREATE OR REPLACE VIEW v_alert_latency AS
SELECT COALESCE(
  percentile_cont(0.95) WITHIN GROUP (
    ORDER BY EXTRACT(EPOCH FROM (delivered_at - matched_at))
  ),
  9999
)::numeric AS p95_seconds
FROM alerts
WHERE matched_at > NOW() - INTERVAL '24 hours'
  AND alert_type = 'synthetic';

-- Criterion 5: calibration drift — Brier score over the last 7 days,
-- using only items old enough (>6h since first_seen_at) for the
-- "reached_front_page within 6h" label to be settled. Defaults to 1
-- (worst possible) when there is no labelled history (treated as fail).
CREATE OR REPLACE VIEW v_calibration_brier_7d AS
SELECT COALESCE(
  ROUND(
    AVG(POWER(s.p_front_page_6h - (CASE WHEN i.reached_front_page THEN 1 ELSE 0 END), 2))::numeric,
    4
  ),
  1
) AS brier_score
FROM item_snapshots s
JOIN items i ON i.id = s.item_id
WHERE s.taken_at > NOW() - INTERVAL '7 days'
  AND i.first_seen_at < NOW() - INTERVAL '6 hours';
