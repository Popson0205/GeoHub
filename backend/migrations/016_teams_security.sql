-- Teams (departments) with leads, two-step sign-in, and API keys.

-- ---------- teams ----------
CREATE TABLE IF NOT EXISTS org_teams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS org_teams_name_key ON org_teams (org_id, lower(name));

-- People in a team; a lead manages the team's people and runs its projects.
CREATE TABLE IF NOT EXISTS team_members (
  team_id uuid NOT NULL REFERENCES org_teams ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  lead boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, user_id)
);
CREATE INDEX IF NOT EXISTS team_members_user_idx ON team_members (user_id);

-- A team given a project: everyone in it gets the role.
CREATE TABLE IF NOT EXISTS project_teams (
  project_id uuid NOT NULL REFERENCES projects ON DELETE CASCADE,
  team_id uuid NOT NULL REFERENCES org_teams ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('admin','collector','viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, team_id)
);
CREATE INDEX IF NOT EXISTS project_teams_team_idx ON project_teams (team_id);

-- The role each person gets on a project through their teams: the team's role (a lead's is admin), kept within
-- what their kind of place allows (field collectors at most collector, viewers viewer), and only while they are
-- in the project's organization.
CREATE OR REPLACE VIEW team_project_roles AS
SELECT project_id, user_id, (ARRAY['viewer','collector','admin'])[max(rank)] AS role
FROM (
  SELECT pt.project_id, tm.user_id,
         CASE WHEN om.role = 'viewer' THEN 1
              WHEN om.role = 'collector' THEN LEAST(2, array_position(ARRAY['viewer','collector','admin'], pt.role))
              WHEN tm.lead THEN 3
              ELSE array_position(ARRAY['viewer','collector','admin'], pt.role) END AS rank
  FROM project_teams pt
  JOIN team_members tm ON tm.team_id = pt.team_id
  JOIN projects p ON p.id = pt.project_id
  JOIN org_members om ON om.user_id = tm.user_id AND om.org_id = p.org_id
) s
GROUP BY project_id, user_id;

-- ---------- two-step sign-in ----------
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret text;            -- encrypted; set while setting up, then kept
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_last_step bigint;       -- a code works once
CREATE TABLE IF NOT EXISTS mfa_recovery_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  code_hash text NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mfa_recovery_codes_user_idx ON mfa_recovery_codes (user_id);
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS require_mfa boolean NOT NULL DEFAULT false;

-- ---------- API keys ----------
CREATE TABLE IF NOT EXISTS api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,       -- the key acts as this person
  name text NOT NULL,
  prefix text NOT NULL,                                           -- shown to tell keys apart
  key_hash text NOT NULL UNIQUE,
  access text NOT NULL CHECK (access IN ('read','write')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  last_used_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS api_keys_org_idx ON api_keys (org_id);
CREATE INDEX IF NOT EXISTS api_keys_user_idx ON api_keys (user_id);
