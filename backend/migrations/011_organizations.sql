-- Organizations: every person belongs to exactly one, and projects and maps belong to one.
-- One deployment can host many client organizations (each sees only its own work), or run as a private
-- copy for a single client (SINGLE_ORG=true).

CREATE TABLE IF NOT EXISTS organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL,
  -- Commercial groundwork: set by hand for now. Missing limits mean unlimited.
  plan text NOT NULL DEFAULT 'free',
  limits jsonb NOT NULL DEFAULT '{}',          -- {"seats": 10, "projects": 5, "records": 50000}
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS organizations_slug_key ON organizations (slug);

-- One row per person (the primary key makes it one organization per person).
CREATE TABLE IF NOT EXISTS org_members (
  user_id uuid PRIMARY KEY REFERENCES users ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner','admin','member')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS org_members_org_idx ON org_members (org_id);

-- People invited by email who have no account yet; they join when they sign up with that email.
CREATE TABLE IF NOT EXISTS org_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,
  email text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin','member')),
  invited_by uuid REFERENCES users ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS org_invitations_email_key ON org_invitations (org_id, lower(email));

ALTER TABLE projects ADD COLUMN IF NOT EXISTS org_id uuid REFERENCES organizations ON DELETE CASCADE;
ALTER TABLE workspace_maps ADD COLUMN IF NOT EXISTS org_id uuid REFERENCES organizations ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS projects_org_idx ON projects (org_id);
CREATE INDEX IF NOT EXISTS workspace_maps_org_idx ON workspace_maps (org_id);

-- Existing data: everyone who already works together keeps doing so. All existing people and all existing
-- work go into one organization. Its owner is the earliest account; everyone else is a member.
DO $$
DECLARE o uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM users) AND NOT EXISTS (SELECT 1 FROM organizations) THEN
    INSERT INTO organizations (name, slug) VALUES ('My organization', 'my-organization') RETURNING id INTO o;
    INSERT INTO org_members (user_id, org_id, role)
      SELECT id, o, CASE WHEN rn = 1 THEN 'owner' ELSE 'member' END
      FROM (SELECT id, row_number() OVER (ORDER BY created_at, id) AS rn FROM users) u;
    UPDATE projects SET org_id = o WHERE org_id IS NULL;
    UPDATE workspace_maps SET org_id = o WHERE org_id IS NULL;
  END IF;
END $$;
