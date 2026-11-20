-- White-label identity set by GeoEstate staff when a customer is set up, so one build serves every client: the
-- suite/wordmark name shown in place of "Geohub", and a square seal/crest URL for the sign-in screen. The brand
-- colour and logo already live on the organization (brand_color, logo). All are applied at runtime from the org
-- record; nothing is baked in at build time.
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS brand_name text,       -- e.g. "Osun State Land Information System"; null = "Geohub"
  ADD COLUMN IF NOT EXISTS brand_seal_url text;   -- URL of a square seal/crest for the sign-in screen; null = none
