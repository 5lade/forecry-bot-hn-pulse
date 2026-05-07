-- 0002_alerts.sql
-- Adds an index supporting the alert dispatcher's 30-minute dedup lookup
-- on (user_id, item_id, alert_type, matched_at). The base alerts table
-- itself is created in 0001_init.sql; matched_at and delivered_at are
-- already present from that migration.

CREATE INDEX alerts_dedup_idx
  ON alerts (user_id, item_id, alert_type, matched_at DESC);
