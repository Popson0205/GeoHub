-- Optional bounds the uploader gives for images that carry no coordinates (plain JPEG/PNG...).
ALTER TABLE imagery_assets ADD COLUMN georef_hint jsonb;   -- {"bounds": [w, s, e, n], "crs": "EPSG:4326"}
