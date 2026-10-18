-- Standalone mapping workspaces: digitise features over imagery, independent of projects and forms.
-- Table names are prefixed (workspace_*) so they never clash with other tables in the same database.
CREATE TABLE IF NOT EXISTS workspace_maps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  -- Imagery sources added by URL: [{"id", "name", "type": "xyz", "url": "https://.../{z}/{x}/{y}", "maxzoom"?, "attribution"?}]
  sources jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ws_maps_owner_idx ON workspace_maps (owner_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS workspace_features (
  id uuid PRIMARY KEY,                           -- generated on the client
  map_id uuid NOT NULL REFERENCES workspace_maps ON DELETE CASCADE,
  geom geometry(Geometry, 4326) NOT NULL,
  properties jsonb NOT NULL DEFAULT '{}',        -- free-form tags, like OpenStreetMap
  version int NOT NULL DEFAULT 1,
  created_by uuid REFERENCES users ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ws_features_map_idx ON workspace_features (map_id);
CREATE INDEX IF NOT EXISTS ws_features_geom_idx ON workspace_features USING gist (geom);

-- Uploaded imagery (GeoTIFF etc.) can belong to a map instead of a project.
-- Written to be safe on databases where an earlier, different attempt already touched these columns:
-- old constraints on map_id are replaced, and existing rows are never checked or changed (NOT VALID).
ALTER TABLE imagery_assets ALTER COLUMN project_id DROP NOT NULL;
ALTER TABLE imagery_assets ADD COLUMN IF NOT EXISTS map_id uuid;
DO $$
DECLARE c text;
BEGIN
  FOR c IN SELECT con.conname FROM pg_constraint con
           JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = ANY (con.conkey)
           WHERE con.conrelid = 'imagery_assets'::regclass AND con.contype = 'f' AND a.attname = 'map_id'
  LOOP
    EXECUTE format('ALTER TABLE imagery_assets DROP CONSTRAINT %I', c);
  END LOOP;
END $$;
ALTER TABLE imagery_assets DROP CONSTRAINT IF EXISTS imagery_scope_chk;
ALTER TABLE imagery_assets ADD CONSTRAINT imagery_map_fk FOREIGN KEY (map_id) REFERENCES workspace_maps ON DELETE CASCADE NOT VALID;
ALTER TABLE imagery_assets ADD CONSTRAINT imagery_scope_chk CHECK (project_id IS NOT NULL OR map_id IS NOT NULL) NOT VALID;
CREATE INDEX IF NOT EXISTS imagery_map_idx ON imagery_assets (map_id);
