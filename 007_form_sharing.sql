-- Sharing a form by link. Every form gets an unguessable token; `share_mode` decides who may use the link.
--   collaborators  only people added to the project (the default; they sign in)
--   public         anyone with the link, no sign-in
ALTER TABLE forms
  ADD COLUMN IF NOT EXISTS share_mode text NOT NULL DEFAULT 'collaborators' CHECK (share_mode IN ('collaborators', 'public')),
  ADD COLUMN IF NOT EXISTS share_token text NOT NULL DEFAULT replace(gen_random_uuid()::text, '-', '');
CREATE UNIQUE INDEX IF NOT EXISTS forms_share_token_key ON forms (share_token);
