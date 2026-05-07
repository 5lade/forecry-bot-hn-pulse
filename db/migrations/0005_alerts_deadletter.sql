-- 0005_alerts_deadletter.sql
-- Stores alerts whose Telegram delivery failed terminally after retries
-- so an operator can replay or audit them later. Schema mirrors the
-- ticket spec exactly: id / alert_payload / error_message / attempts /
-- created_at. The original alert_id is preserved inside alert_payload.

CREATE TABLE alerts_deadletter (
  id UUID PRIMARY KEY,
  alert_payload JSONB NOT NULL,
  error_message TEXT,
  attempts INT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX alerts_deadletter_created_at_idx
  ON alerts_deadletter (created_at DESC);
