-- A form made from a ready-made template remembers which, so the GeoEstate apps that read it (Land Registry's
-- enumeration) know what each question means without being told.
ALTER TABLE forms ADD COLUMN template text;
