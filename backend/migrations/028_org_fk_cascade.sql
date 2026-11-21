-- Deleting a customer must remove all of its data. Most foreign keys to organizations are already ON DELETE CASCADE,
-- but a database built up over time can carry a few that are not (NO ACTION / RESTRICT), and those silently block a
-- delete. This finds every single-column foreign key that points at organizations and, unless it is already CASCADE
-- or SET NULL, recreates it as ON DELETE CASCADE. It is idempotent: a second run finds nothing to change.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT con.conname AS name, con.conrelid::regclass::text AS tbl, att.attname AS col
    FROM pg_constraint con
    JOIN pg_class ref ON ref.oid = con.confrelid
    JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = con.conkey[1]
    WHERE con.contype = 'f'
      AND ref.relname = 'organizations'
      AND array_length(con.conkey, 1) = 1   -- single-column FKs (org_id); leave any composite keys alone
      AND con.confdeltype NOT IN ('c', 'n') -- not already CASCADE or SET NULL
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.tbl, r.name);
    EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES organizations(id) ON DELETE CASCADE',
                   r.tbl, r.name, r.col);
  END LOOP;
END $$;
