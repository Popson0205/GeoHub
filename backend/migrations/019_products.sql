-- A licence per product. Geohub's own licence stays on the organization (plan, dates, kind, caps); every other
-- GeoEstate product an organization has (Land Registry, LandCheck, FarmScan) gets a row here, with its own plan, dates,
-- kind (paid or demo), caps and feature switches. Suspending the organization suspends all of them.
CREATE TABLE IF NOT EXISTS org_products (
  org_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,
  product text NOT NULL CHECK (product IN ('land','check','farm')),
  plan text NOT NULL CHECK (plan IN ('standard','advanced','custom')),
  licence_kind text NOT NULL DEFAULT 'paid' CHECK (licence_kind IN ('paid','demo')),
  subscription_starts date,
  subscription_ends date,
  limits jsonb NOT NULL DEFAULT '{}',              -- numbers on top of the plan's, e.g. {"reports_per_month": 80}
  features jsonb NOT NULL DEFAULT '{}',            -- switches on top of the plan's, e.g. {"dxf_import": true}
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, product),
  CHECK (subscription_starts IS NULL OR subscription_ends IS NULL OR subscription_ends >= subscription_starts)
);
CREATE INDEX IF NOT EXISTS org_products_ends_idx ON org_products (subscription_ends);

-- The licence history and the renewal reminders say which product they are about ('hub' = Geohub).
ALTER TABLE licence_events ADD COLUMN IF NOT EXISTS product text NOT NULL DEFAULT 'hub';
ALTER TABLE subscription_reminders ADD COLUMN IF NOT EXISTS product text NOT NULL DEFAULT 'hub';
ALTER TABLE subscription_reminders DROP CONSTRAINT IF EXISTS subscription_reminders_pkey;
ALTER TABLE subscription_reminders ADD PRIMARY KEY (org_id, product, ends_on, days_before);
