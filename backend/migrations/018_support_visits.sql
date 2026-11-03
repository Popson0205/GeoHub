-- GeoEstate support opening a customer's projects to help them: read-only, for a limited time, with a reason, and
-- shown to the customer's owners and administrators.
CREATE TABLE IF NOT EXISTS support_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,
  staff_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  reason text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  ends_at timestamptz NOT NULL,
  ended_at timestamptz
);
CREATE INDEX IF NOT EXISTS support_sessions_staff_idx ON support_sessions (staff_id, org_id);
CREATE INDEX IF NOT EXISTS support_sessions_org_idx ON support_sessions (org_id, started_at DESC);
