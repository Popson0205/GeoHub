-- Rasters in the Data hub (elevation models, drone orthophotos, analysis results published from PolyGIS): a raster
-- dataset's version is one Cloud-Optimised GeoTIFF, kept like a vector version's GeoJSON snapshot (snapshot_key), with
-- what it holds described in `raster`. geometry_type is 'raster' and feature_count 0.
ALTER TABLE dataset_versions ADD COLUMN IF NOT EXISTS raster jsonb;
-- {"bands": [{"min", "max", "mean", "name"}], "width", "height", "crs", "resolution", "nodata", "data_type", "size", "render": {...}}

-- A raster on its way from an app: uploaded in parts straight to storage, then converted by the worker. A new dataset
-- is made when the upload is complete; until its conversion finishes it has no version, as a dataset from a form does.
CREATE TABLE IF NOT EXISTS dataset_uploads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app text NOT NULL,
  org_id uuid REFERENCES organizations ON DELETE CASCADE,
  created_by uuid REFERENCES users ON DELETE CASCADE,
  dataset_id uuid REFERENCES datasets ON DELETE CASCADE,  -- set for a new version, or once a new dataset is made
  meta jsonb NOT NULL DEFAULT '{}',                        -- title, description, licence… for a new dataset
  filename text NOT NULL,
  size bigint NOT NULL,
  source_key text NOT NULL,
  upload_id text,
  status text NOT NULL DEFAULT 'uploading' CHECK (status IN ('uploading', 'processing', 'ready', 'failed')),
  version int,
  job_id uuid,
  error text,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS dataset_uploads_user_idx ON dataset_uploads (created_by, created_at DESC);

-- the worker's job that turns an uploaded raster into a dataset version
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_kind_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_kind_check CHECK (kind IN ('imagery_convert', 'export', 'snapshot', 'import', 'raster_dataset'));
