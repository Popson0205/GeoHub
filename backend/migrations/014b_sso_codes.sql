-- One-time codes from Google / Microsoft sign-in, kept in the database (before, in Redis: a deployment without
-- Redis could not finish signing in). Only a hash is stored; each works once, for two minutes.
CREATE TABLE IF NOT EXISTS sso_codes (
  code_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);
