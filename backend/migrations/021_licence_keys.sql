-- Signed licence keys, for customers who run Geohub (and the other GeoEstate products) on their own servers or in their
-- own cloud. GeoEstate issues them from the staff console; the installation keeps the one in force.
CREATE TABLE IF NOT EXISTS licence_keys (                -- issued, on GeoEstate's own deployment
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,
  installation text NOT NULL,                           -- the installation's web address
  payload jsonb NOT NULL,
  key text NOT NULL,
  note text,
  issued_by uuid REFERENCES users ON DELETE SET NULL,
  issued_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS licence_keys_org_idx ON licence_keys (org_id, issued_at DESC);

CREATE TABLE IF NOT EXISTS installation_licence (       -- installed, on the customer's own deployment: one row
  id int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  key text NOT NULL,
  key_id uuid NOT NULL,
  payload jsonb NOT NULL,
  installed_by uuid REFERENCES users ON DELETE SET NULL,
  installed_at timestamptz NOT NULL DEFAULT now()
);
