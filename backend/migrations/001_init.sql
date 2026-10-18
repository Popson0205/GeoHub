CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------- identity ----------
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  name text NOT NULL,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_key ON users (lower(email));

CREATE TABLE refresh_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  family_id uuid NOT NULL,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refresh_tokens_family_idx ON refresh_tokens (family_id);

-- ---------- projects and members ----------
CREATE TABLE projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  created_by uuid REFERENCES users ON DELETE SET NULL,
  -- Per-project change counter. Every feature write bumps it while holding this row's lock,
  -- so commits are serialised per project and sync cursors can never skip a change.
  seq_counter bigint NOT NULL DEFAULT 0,
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE members (
  project_id uuid NOT NULL REFERENCES projects ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner','admin','collector','viewer')),
  assigned_area geometry(Geometry, 4326),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id)
);
CREATE INDEX members_user_idx ON members (user_id);

CREATE TABLE invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects ON DELETE CASCADE,
  email text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin','collector','viewer')),
  invited_by uuid REFERENCES users ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX invitations_project_email_key ON invitations (project_id, lower(email));

-- ---------- forms ----------
CREATE TABLE forms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects ON DELETE CASCADE,
  name text NOT NULL,
  geometry_type text NOT NULL CHECK (geometry_type IN ('point','line','area')),
  fields jsonb NOT NULL DEFAULT '[]',          -- the editable draft
  version int NOT NULL DEFAULT 0,              -- latest published version (0 = never published)
  created_by uuid REFERENCES users ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX forms_project_idx ON forms (project_id);

CREATE TABLE form_versions (
  form_id uuid NOT NULL REFERENCES forms ON DELETE CASCADE,
  version int NOT NULL,
  name text NOT NULL,
  geometry_type text NOT NULL,
  fields jsonb NOT NULL,
  published_by uuid REFERENCES users ON DELETE SET NULL,
  published_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (form_id, version)
);

-- ---------- geometry helpers ----------
-- All geometry enters the database through this function: 2D, EPSG:4326, snapped to a 1e-7 degree
-- grid (about 1 cm). Snapping makes "did the geometry change?" comparisons stable across clients.
CREATE FUNCTION geom_from_json(j text) RETURNS geometry AS $$
  SELECT ST_ReducePrecision(ST_Force2D(ST_SetSRID(ST_GeomFromGeoJSON(j), 4326)), 0.0000001)
$$ LANGUAGE sql IMMUTABLE;

CREATE FUNCTION geom_same(a geometry, b geometry) RETURNS boolean AS $$
  SELECT ST_OrderingEquals(ST_ReducePrecision(a, 0.0000001), ST_ReducePrecision(b, 0.0000001))
$$ LANGUAGE sql IMMUTABLE;

-- ---------- features ----------
CREATE TABLE features (
  id uuid PRIMARY KEY,                          -- generated on the client
  project_id uuid NOT NULL REFERENCES projects ON DELETE CASCADE,
  form_id uuid NOT NULL REFERENCES forms,
  form_version int NOT NULL,
  geom geometry(Geometry, 4326) NOT NULL,
  properties jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'submitted' CHECK (status IN ('draft','submitted','approved','rejected')),
  version int NOT NULL DEFAULT 1,
  seq bigint NOT NULL,
  review_note text,
  reviewed_by uuid REFERENCES users ON DELETE SET NULL,
  reviewed_at timestamptz,
  client_updated_at timestamptz,                -- display only, never used for ordering
  created_by uuid REFERENCES users ON DELETE SET NULL,
  updated_by uuid REFERENCES users ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX features_geom_idx ON features USING gist (geom);
CREATE INDEX features_project_seq_idx ON features (project_id, seq);
CREATE INDEX features_project_form_idx ON features (project_id, form_id) WHERE deleted_at IS NULL;

CREATE TABLE feature_versions (
  feature_id uuid NOT NULL REFERENCES features ON DELETE CASCADE,
  version int NOT NULL,
  geom geometry(Geometry, 4326),
  properties jsonb,
  status text,
  deleted boolean NOT NULL DEFAULT false,
  action text NOT NULL,                         -- create | update | merge | delete | restore | review
  changed_by uuid REFERENCES users ON DELETE SET NULL,
  changed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (feature_id, version)
);

-- Idempotency: the same (feature id, client change id) is applied at most once.
CREATE TABLE sync_changes (
  feature_id uuid NOT NULL,
  change_id uuid NOT NULL,
  project_id uuid NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (feature_id, change_id)
);
CREATE INDEX sync_changes_created_idx ON sync_changes (created_at);

-- ---------- media ----------
CREATE TABLE media (
  id uuid PRIMARY KEY,                          -- generated on the client
  project_id uuid NOT NULL REFERENCES projects ON DELETE CASCADE,
  feature_id uuid REFERENCES features ON DELETE CASCADE,
  field_id text,
  kind text NOT NULL DEFAULT 'photo',
  content_type text NOT NULL,
  storage_key text NOT NULL,                    -- original
  web_key text,                                 -- resized copy
  width int,
  height int,
  size bigint,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','uploaded','ready','failed')),
  created_by uuid REFERENCES users ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  uploaded_at timestamptz
);
CREATE INDEX media_feature_idx ON media (feature_id);

-- ---------- imagery ----------
CREATE TABLE imagery_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects ON DELETE CASCADE,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'uploading' CHECK (status IN ('uploading','processing','ready','failed')),
  bounds double precision[],                    -- [minx, miny, maxx, maxy] in EPSG:4326
  crs text,
  resolution double precision,                  -- native pixel size in CRS units
  bands int,
  source_key text NOT NULL,
  storage_key text,                             -- the COG
  upload_id text,
  size bigint,
  error text,
  error_code text,
  created_by uuid REFERENCES users ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX imagery_project_idx ON imagery_assets (project_id);

-- ---------- datasets (public hub) ----------
CREATE TABLE datasets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  project_id uuid NOT NULL REFERENCES projects ON DELETE CASCADE,
  form_id uuid NOT NULL REFERENCES forms,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  license text NOT NULL,
  tags text[] NOT NULL DEFAULT '{}',
  visibility text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','public')),
  statuses text[] NOT NULL DEFAULT '{approved}',  -- feature statuses included in a snapshot
  latest_version int NOT NULL DEFAULT 0,
  created_by uuid REFERENCES users ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX datasets_project_idx ON datasets (project_id);

CREATE TABLE dataset_versions (
  dataset_id uuid NOT NULL REFERENCES datasets ON DELETE CASCADE,
  version int NOT NULL,
  feature_count int NOT NULL DEFAULT 0,
  bbox double precision[],
  fields jsonb NOT NULL,
  geometry_type text NOT NULL,
  snapshot_key text NOT NULL,
  download_count bigint NOT NULL DEFAULT 0,
  published_by uuid REFERENCES users ON DELETE SET NULL,
  published_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (dataset_id, version)
);

-- Immutable copy of the features at publish time (queryable by bbox for previews).
CREATE TABLE dataset_features (
  dataset_id uuid NOT NULL,
  version int NOT NULL,
  feature_id uuid NOT NULL,
  geom geometry(Geometry, 4326) NOT NULL,
  properties jsonb NOT NULL,
  PRIMARY KEY (dataset_id, version, feature_id),
  FOREIGN KEY (dataset_id, version) REFERENCES dataset_versions ON DELETE CASCADE
);
CREATE INDEX dataset_features_geom_idx ON dataset_features USING gist (geom);

CREATE TABLE dataset_exports (
  dataset_id uuid NOT NULL,
  version int NOT NULL,
  format text NOT NULL,
  storage_key text NOT NULL,
  filename text NOT NULL,
  size bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (dataset_id, version, format),
  FOREIGN KEY (dataset_id, version) REFERENCES dataset_versions ON DELETE CASCADE
);

-- ---------- jobs and audit ----------
CREATE TABLE jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('imagery_convert','export','snapshot','import')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed')),
  progress int NOT NULL DEFAULT 0,
  params jsonb NOT NULL DEFAULT '{}',
  result jsonb,
  error text,
  project_id uuid REFERENCES projects ON DELETE CASCADE,
  public boolean NOT NULL DEFAULT false,        -- true for exports of public datasets (readable without login)
  created_by uuid REFERENCES users ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  actor_id uuid,
  actor_ip text,
  project_id uuid,                              -- no FK: the trail outlives the project
  action text NOT NULL,
  target_type text,
  target_id text,
  details jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX audit_project_idx ON audit_log (project_id, id DESC);

-- ---------- vector tiles (served by Martin, called only by the API's authorising proxy) ----------
CREATE FUNCTION feature_tiles(z integer, x integer, y integer, query_params json)
RETURNS bytea AS $$
  SELECT COALESCE(ST_AsMVT(t, 'features', 4096, 'geom'), '')
  FROM (
    SELECT f.id::text AS id, f.status, f.version, f.properties::text AS props,
           ST_AsMVTGeom(ST_Transform(f.geom, 3857), ST_TileEnvelope(z, x, y), 4096, 64, true) AS geom
    FROM features f
    WHERE f.project_id = (query_params->>'project_id')::uuid
      AND f.form_id = (query_params->>'form_id')::uuid
      AND f.deleted_at IS NULL
      AND f.geom && ST_Transform(ST_TileEnvelope(z, x, y), 4326)
  ) t WHERE t.geom IS NOT NULL;
$$ LANGUAGE sql STABLE PARALLEL SAFE;
