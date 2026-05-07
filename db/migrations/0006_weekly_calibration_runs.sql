-- 0006_weekly_calibration_runs.sql
-- Per-user-per-week calibration recap idempotency marker. The
-- weekly-calibration job (p3-001) attempts to claim (user_id, week_key)
-- before sending so a re-run within the same week is a no-op. week_key is
-- the ISO date of the Monday the recap covers (i.e. the start of the
-- previous 7-day window).

CREATE TABLE weekly_calibration_runs (
  user_id UUID NOT NULL REFERENCES users(id),
  week_key DATE NOT NULL,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, week_key)
);
