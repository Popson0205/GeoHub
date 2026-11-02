-- Plans and accounts: people are counted by kind (team seats, field collectors, viewers), organizations have a
-- yearly subscription, admins create accounts, and people set their password from a one-time link.

-- Two more organization roles: field collectors (collect only) and viewers (read only).
ALTER TABLE org_members DROP CONSTRAINT IF EXISTS org_members_role_check;
ALTER TABLE org_members ADD CONSTRAINT org_members_role_check CHECK (role IN ('owner','admin','member','collector','viewer'));
ALTER TABLE org_invitations DROP CONSTRAINT IF EXISTS org_invitations_role_check;
ALTER TABLE org_invitations ADD CONSTRAINT org_invitations_role_check CHECK (role IN ('admin','member','collector','viewer'));

-- Plans: individual (free), standard, advanced, custom. The subscription dates are set by GeoEstate per invoice.
ALTER TABLE organizations ALTER COLUMN plan SET DEFAULT 'individual';
UPDATE organizations SET plan = 'individual' WHERE plan = 'free';
UPDATE organizations SET plan = 'advanced' WHERE slug = 'my-organization';
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS subscription_starts date;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS subscription_ends date;

-- An account an admin made with a temporary password must choose its own at first sign-in.
ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false;

-- One-time links to set a password (new accounts) or reset it (forgot password). Only a hash is stored.
CREATE TABLE IF NOT EXISTS password_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  purpose text NOT NULL CHECK (purpose IN ('set','reset')),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS password_tokens_user_idx ON password_tokens (user_id);
