-- The GeoEstate staff console: staff with roles, a history of every licence change, staff notes on customers,
-- suspension, demo licences, and when each person last signed in.

-- Staff beyond the PLATFORM_ADMINS emails (who are always super admins).
CREATE TABLE IF NOT EXISTS platform_staff (
  user_id uuid PRIMARY KEY REFERENCES users ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('super_admin','account_manager','support','finance')),
  added_by uuid REFERENCES users ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- A licence is the organization's plan, dates and caps. Its kind: paid (after an invoice) or demo (a month's trial).
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS licence_kind text NOT NULL DEFAULT 'paid';
ALTER TABLE organizations DROP CONSTRAINT IF EXISTS organizations_licence_kind_check;
ALTER TABLE organizations ADD CONSTRAINT organizations_licence_kind_check CHECK (licence_kind IN ('paid','demo'));
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS suspended_at timestamptz;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS suspended_reason text;

-- Every change to a licence, with who made it, why, and the invoice it answers.
CREATE TABLE IF NOT EXISTS licence_events (
  id bigserial PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,
  action text NOT NULL,                     -- create, demo, renew, change, suspend, reactivate
  plan text NOT NULL,
  kind text NOT NULL,
  starts date,
  ends date,
  limits jsonb NOT NULL DEFAULT '{}',
  invoice_ref text,
  note text,
  actor_id uuid REFERENCES users ON DELETE SET NULL,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS licence_events_org_idx ON licence_events (org_id, id DESC);

-- What we know today, as the first entry of each paid organization's history.
INSERT INTO licence_events (org_id, action, plan, kind, starts, ends, limits, note)
SELECT o.id, 'create', o.plan, o.licence_kind, o.subscription_starts, o.subscription_ends, o.limits, 'Recorded when the staff console was added'
FROM organizations o
WHERE o.plan <> 'individual' AND NOT EXISTS (SELECT 1 FROM licence_events e WHERE e.org_id = o.id);

-- Staff notes on a customer: calls, promises, anything the next person should know.
CREATE TABLE IF NOT EXISTS org_staff_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,
  author_id uuid REFERENCES users ON DELETE SET NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS org_staff_notes_org_idx ON org_staff_notes (org_id, created_at DESC);

ALTER TABLE users ADD COLUMN IF NOT EXISTS last_sign_in_at timestamptz;

-- Website requests can ask for a month's demo licence.
ALTER TABLE org_requests DROP CONSTRAINT IF EXISTS org_requests_plan_check;
ALTER TABLE org_requests ADD CONSTRAINT org_requests_plan_check CHECK (plan IN ('standard','advanced','custom','unsure','demo'));

CREATE INDEX IF NOT EXISTS audit_action_idx ON audit_log (action, id DESC);
