-- Maps: a free-form web-mapping workspace, independent of data-collection projects and forms.
-- A map holds layers (with their own free attribute fields), features drawn on those layers and imagery
-- sources (XYZ tile URL templates). Collection projects, forms and sync are untouched.
CREATE TABLE maps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  created_by uuid REFERENCES users ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE map_members (
  map_id uuid NOT NULL REFERENCES maps ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner','editor','viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (map_id, user_id)
);
CREATE INDEX map_members_user_idx ON map_members (user_id);

CREATE TABLE map_layers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  map_id uuid NOT NULL REFERENCES maps ON DELETE CASCADE,
  name text NOT NULL,
  geometry_type text NOT NULL DEFAULT 'any' CHECK (geometry_type IN ('point','line','area','any')),
  fields jsonb NOT NULL DEFAULT '[]',           -- [{id, label, type}] free attribute table, no form versions
  style jsonb NOT NULL DEFAULT '{}',
  position int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX map_layers_map_idx ON map_layers (map_id, position);

CREATE TABLE map_features (
  id uuid PRIMARY KEY,                           -- generated on the client
  map_id uuid NOT NULL REFERENCES maps ON DELETE CASCADE,
  layer_id uuid NOT NULL REFERENCES map_layers ON DELETE CASCADE,
  geom geometry(Geometry, 4326) NOT NULL,
  properties jsonb NOT NULL DEFAULT '{}',
  version int NOT NULL DEFAULT 1,
  created_by uuid REFERENCES users ON DELETE SET NULL,
  updated_by uuid REFERENCES users ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX map_features_geom_idx ON map_features USING gist (geom);
CREATE INDEX map_features_layer_idx ON map_features (layer_id) WHERE deleted_at IS NULL;
CREATE INDEX map_features_map_idx ON map_features (map_id, updated_at);

-- Imagery sources. XYZ sources are fetched by the browser straight from the provider; only the record is stored.
CREATE TABLE map_imagery_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  map_id uuid NOT NULL REFERENCES maps ON DELETE CASCADE,
  name text NOT NULL,
  kind text NOT NULL DEFAULT 'xyz' CHECK (kind IN ('xyz')),   -- 'upload' joins in a later migration
  url_template text NOT NULL,                    -- https://host/{z}/{x}/{y}.png
  attribution text NOT NULL DEFAULT '',
  min_zoom int NOT NULL DEFAULT 0 CHECK (min_zoom BETWEEN 0 AND 24),
  max_zoom int NOT NULL DEFAULT 19 CHECK (max_zoom BETWEEN 0 AND 24),
  tile_size int NOT NULL DEFAULT 256 CHECK (tile_size IN (256, 512)),
  position int NOT NULL DEFAULT 0,
  created_by uuid REFERENCES users ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (min_zoom <= max_zoom)
);
CREATE INDEX map_imagery_map_idx ON map_imagery_sources (map_id, position);
