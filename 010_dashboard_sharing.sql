-- Share a dashboard by link. `share_token` is NULL while the dashboard is private (the default). Turning sharing on
-- issues a random token; turning it off, or regenerating, deletes the old one, so an old link can never work again.
ALTER TABLE dashboards ADD COLUMN IF NOT EXISTS share_token text;
CREATE UNIQUE INDEX IF NOT EXISTS dashboards_share_token_key ON dashboards (share_token) WHERE share_token IS NOT NULL;
