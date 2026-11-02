-- Requests for an organization from the website, and a record of renewal reminders sent (so each goes once).

CREATE TABLE IF NOT EXISTS org_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization text NOT NULL,
  contact_name text NOT NULL,
  email text NOT NULL,
  phone text,
  plan text NOT NULL CHECK (plan IN ('standard','advanced','custom','unsure')),
  team_size text,
  message text,
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new','contacted','set_up','declined')),
  note text,
  org_id uuid REFERENCES organizations ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS org_requests_status_idx ON org_requests (status, created_at DESC);

CREATE TABLE IF NOT EXISTS subscription_reminders (
  org_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,
  ends_on date NOT NULL,
  days_before int NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, ends_on, days_before)
);
