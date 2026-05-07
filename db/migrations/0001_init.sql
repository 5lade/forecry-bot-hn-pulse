-- 0001_init.sql
-- Initial HN Pulse schema. Mirrors Spec.md "Data model (Postgres)".

CREATE TABLE users (
  id UUID PRIMARY KEY,
  telegram_user_id BIGINT UNIQUE NOT NULL,
  tier TEXT NOT NULL DEFAULT 'free',
  threshold_pct INT NOT NULL DEFAULT 60,
  digest_opt_in BOOLEAN NOT NULL DEFAULT TRUE,
  stripe_customer_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE items (
  id INT PRIMARY KEY,
  by TEXT,
  title TEXT,
  url TEXT,
  domain TEXT,
  posted_at TIMESTAMPTZ NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL,
  reached_front_page BOOLEAN,
  reached_front_page_at TIMESTAMPTZ
);

CREATE TABLE item_snapshots (
  item_id INT REFERENCES items(id),
  taken_at TIMESTAMPTZ NOT NULL,
  rank INT,
  score INT,
  comments INT,
  score_velocity NUMERIC,
  comment_velocity NUMERIC,
  p_front_page_6h NUMERIC,
  delta_p_5min NUMERIC,
  PRIMARY KEY (item_id, taken_at)
);

CREATE TABLE watches (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  watch_type TEXT NOT NULL,
  watch_value TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE alerts (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  item_id INT REFERENCES items(id),
  alert_type TEXT NOT NULL,
  matched_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  payload JSONB
);

CREATE INDEX ON items (first_seen_at);
CREATE INDEX ON item_snapshots (taken_at);
CREATE INDEX ON watches (watch_type, watch_value);
CREATE INDEX ON alerts (user_id, item_id, alert_type, sent_at DESC);
