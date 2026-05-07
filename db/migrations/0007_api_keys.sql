-- 0007_api_keys.sql
-- pulse-pro API bearer tokens. The plaintext key is shown to the user once
-- at creation time and never stored: we keep only a SHA-256 hash for lookup
-- plus a short prefix for display ("hnp_xxx…"). Revocation is soft via
-- revoked_at so audit trails survive.

CREATE TABLE api_keys (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  key_hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,
  name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);

CREATE INDEX ON api_keys (user_id);
