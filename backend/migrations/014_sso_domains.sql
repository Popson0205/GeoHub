-- Google / Microsoft sign-in, and joining an organization by company email domain.

-- Which Google or Microsoft account signs in as which person. Matched by the provider's stable id, so a person
-- keeps their account if their email changes there.
CREATE TABLE IF NOT EXISTS user_identities (
  provider text NOT NULL CHECK (provider IN ('google','microsoft')),
  subject text NOT NULL,
  user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  email text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  PRIMARY KEY (provider, subject)
);
CREATE INDEX IF NOT EXISTS user_identities_user_idx ON user_identities (user_id);

-- An organization's company email domains. A domain belongs to one organization, and only joins people once its
-- ownership is proven (a DNS TXT record, or checked by GeoEstate).
CREATE TABLE IF NOT EXISTS org_domains (
  domain text PRIMARY KEY CHECK (domain = lower(domain)),
  org_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,
  verify_token text NOT NULL,
  verified_at timestamptz,
  auto_join boolean NOT NULL DEFAULT true,
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('member','collector','viewer')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS org_domains_org_idx ON org_domains (org_id);

-- A link that confirms someone owns their email before they join by its domain.
ALTER TABLE password_tokens DROP CONSTRAINT IF EXISTS password_tokens_purpose_check;
ALTER TABLE password_tokens ADD CONSTRAINT password_tokens_purpose_check CHECK (purpose IN ('set','reset','join'));
ALTER TABLE password_tokens ADD COLUMN IF NOT EXISTS org_id uuid REFERENCES organizations ON DELETE CASCADE;
