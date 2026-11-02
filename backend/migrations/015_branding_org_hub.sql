-- An organization's own look (logo, colour, email sender), and Data hub datasets visible to its people only.
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS brand_color text CHECK (brand_color ~ '^#[0-9a-f]{6}$');
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS logo bytea;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS logo_updated_at timestamptz;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS email_sender_name text;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS email_reply_to text;

ALTER TABLE datasets DROP CONSTRAINT IF EXISTS datasets_visibility_check;
ALTER TABLE datasets ADD CONSTRAINT datasets_visibility_check CHECK (visibility IN ('private','organization','public'));
