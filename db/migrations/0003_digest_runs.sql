-- 0003_digest_runs.sql
-- Per-user-per-day digest idempotency marker. The daily-digest job (p1-008)
-- attempts to claim (user_id, digest_date) before sending so a re-run on the
-- same calendar day is a no-op. digest_date is the UTC date the digest covers
-- (i.e. yesterday relative to the run time).

CREATE TABLE digest_runs (
  user_id UUID NOT NULL REFERENCES users(id),
  digest_date DATE NOT NULL,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, digest_date)
);
