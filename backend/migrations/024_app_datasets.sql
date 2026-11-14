-- Data hub datasets published from the other GeoEstate apps (PolyGIS layers, for a start): no Geohub project, form or
-- map behind them, so they carry their organization and where they came from, and each version is sent by the app.
ALTER TABLE datasets
  ADD COLUMN IF NOT EXISTS org_id uuid REFERENCES organizations ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS source jsonb;          -- {"app": "gis", "name": "PolyGIS", "ref": "<layer id>", "label": "Bosso Estate › parcels"}
CREATE INDEX IF NOT EXISTS datasets_source_idx ON datasets ((source->>'app'), (source->>'ref')) WHERE source IS NOT NULL;
