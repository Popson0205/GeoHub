-- Shared maps: members, mapping campaigns (with an optional competition), per-feature authorship and review,
-- and publishing a map's approved features to the Data hub.

-- Campaign settings live on the map itself. Everything here is optional; an ordinary map ignores it.
ALTER TABLE workspace_maps
  ADD COLUMN IF NOT EXISTS is_campaign boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS goal text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS starts_at timestamptz,
  ADD COLUMN IF NOT EXISTS ends_at timestamptz,
  ADD COLUMN IF NOT EXISTS competition boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS join_code text;                      -- NULL = joining by link is closed
CREATE UNIQUE INDEX IF NOT EXISTS ws_maps_join_code_idx ON workspace_maps (join_code) WHERE join_code IS NOT NULL;

-- The owner is not listed here (workspace_maps.owner_id). Everyone else who can open the map is.
CREATE TABLE IF NOT EXISTS map_members (
  map_id uuid NOT NULL REFERENCES workspace_maps ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'contributor' CHECK (role IN ('reviewer', 'contributor')),
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (map_id, user_id)
);
CREATE INDEX IF NOT EXISTS map_members_user_idx ON map_members (user_id);

-- Who drew and who reviewed. Features that already exist were drawn by the owner, so they count as approved.
ALTER TABLE workspace_features
  ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES users ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'approved' CHECK (status IN ('submitted', 'approved', 'rejected')),
  ADD COLUMN IF NOT EXISTS reviewed_by uuid REFERENCES users ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS review_note text NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS ws_features_author_idx ON workspace_features (map_id, created_by);
CREATE INDEX IF NOT EXISTS ws_features_status_idx ON workspace_features (map_id, status);

-- A dataset can now come from a map instead of a project form.
ALTER TABLE datasets
  ALTER COLUMN project_id DROP NOT NULL,
  ALTER COLUMN form_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS map_id uuid REFERENCES workspace_maps ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS map_geometry text CHECK (map_geometry IN ('point', 'line', 'area')),
  ADD COLUMN IF NOT EXISTS credit_contributors boolean NOT NULL DEFAULT true;
CREATE INDEX IF NOT EXISTS datasets_map_idx ON datasets (map_id);
ALTER TABLE dataset_versions ADD COLUMN IF NOT EXISTS contributors jsonb NOT NULL DEFAULT '[]';   -- [{"name", "features"}]
