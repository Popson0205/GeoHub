-- GeoEstate ID: Geohub signs people in to the other GeoEstate apps (Land Registry, LandCheck, FarmScan) with the
-- authorization-code flow. A code is used once within 2 minutes; a refresh token lasts 30 days and is replaced each use.
CREATE TABLE IF NOT EXISTS id_codes (
  code_hash text PRIMARY KEY,
  client_id text NOT NULL,
  user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  redirect_uri text NOT NULL,
  code_challenge text,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS id_refresh_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE,
  client_id text NOT NULL,
  user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS id_refresh_tokens_user_idx ON id_refresh_tokens (user_id, client_id);
