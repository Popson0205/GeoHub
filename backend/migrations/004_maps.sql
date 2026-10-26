-- Standalone mapping workspaces ("maps"): digitise features over imagery, independent of projects and forms.
CREATE TABLE maps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  -- Imagery sources added by URL: [{"id", "name", "type": "xyz", "url": "https://.../{z}/{x}/{y}", "maxzoom"?, "attribution"?}]
  sources jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX maps_owner_idx ON maps (owner_id, updated_at DESC);

CREATE TABLE map_features (
  id uuid PRIMARY KEY,                           -- generated on the client
  map_id uuid NOT NULL REFERENCES maps ON DELETE CASCADE,
  geom geometry(Geometry, 4326) NOT NULL,
  properties jsonb NOT NULL DEFAULT '{}',        -- free-form tags, like OpenStreetMap
  version int NOT NULL DEFAULT 1,
  created_by uuid REFERENCES users ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX map_features_map_idx ON map_features (map_id);
CREATE INDEX map_features_geom_idx ON map_features USING gist (geom);

-- Uploaded imagery (GeoTIFF etc.) can now belong to a map instead of a project.
ALTER TABLE imagery_assets ALTER COLUMN project_id DROP NOT NULL;
ALTER TABLE imagery_assets ADD COLUMN map_id uuid REFERENCES maps ON DELETE CASCADE;
ALTER TABLE imagery_assets ADD CONSTRAINT imagery_scope_chk CHECK ((project_id IS NULL) <> (map_id IS NULL));
CREATE INDEX imagery_map_idx ON imagery_assets (map_id);
