-- The sign-in seal/crest is now an uploaded image (like the logo), not a URL. Store the image bytes and the time
-- it was uploaded; the served URL carries ?v=<that time> so a new seal is a new URL. brand_seal_url (migration 026)
-- is left in place but no longer used.
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS brand_seal bytea,
  ADD COLUMN IF NOT EXISTS brand_seal_updated_at timestamptz;
