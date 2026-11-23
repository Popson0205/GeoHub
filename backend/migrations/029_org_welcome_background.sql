-- A welcome/home-page background image for the organization, set by GeoEstate at org setup (like ArcGIS Online's org
-- banner). A wide landscape photo, stored as JPEG; served with ?v=<upload time> so a new image is a new URL.
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS brand_home_image bytea,
  ADD COLUMN IF NOT EXISTS brand_home_image_updated_at timestamptz;
