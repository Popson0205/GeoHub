-- PolyGIS, the web GIS, becomes a GeoEstate product licensed like the others.
ALTER TABLE org_products DROP CONSTRAINT IF EXISTS org_products_product_check;
ALTER TABLE org_products ADD CONSTRAINT org_products_product_check CHECK (product IN ('land','check','farm','gis'));
