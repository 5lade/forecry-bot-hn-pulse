-- 0008_service_heartbeats.sql
-- Durable service heartbeat state for soak acceptance checks.
--
-- Poller liveness must measure successful poller activity, not only newly
-- inserted HN items. When HN has no unseen stories, MAX(items.first_seen_at)
-- can become stale even though /newstories batches are succeeding.

CREATE TABLE IF NOT EXISTS service_heartbeats (
  service TEXT PRIMARY KEY,
  checked_at TIMESTAMPTZ NOT NULL,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS service_heartbeats_checked_at_idx
  ON service_heartbeats (checked_at DESC);

-- Criterion 1: poller liveness — lag between NOW() and the most recent
-- successful HN /newstories poll heartbeat, in seconds. NULL when the
-- heartbeat has not been recorded yet, which is an honest fail signal.
CREATE OR REPLACE VIEW v_poller_lag AS
SELECT EXTRACT(EPOCH FROM (NOW() - MAX(checked_at)))::numeric AS lag_seconds
FROM service_heartbeats
WHERE service = 'hn_newstories_poller';
