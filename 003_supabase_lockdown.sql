-- Supabase exposes every table in the public schema through its REST/GraphQL "Data API" using the public
-- anon key. This backend never uses that API (it connects straight to Postgres), so make sure nothing in public
-- is reachable through it: row-level security on with no policies, and no grants for the API roles.
-- On a plain Postgres (CI, local) the anon/authenticated roles do not exist and only the RLS part runs.
-- app/db.py calls hub_lockdown() after every migration run, so tables added by later migrations are covered too.
CREATE OR REPLACE FUNCTION hub_lockdown() RETURNS void LANGUAGE plpgsql AS $fn$
DECLARE
  r record;
  api_role text;
BEGIN
  FOR r IN
    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relrowsecurity
      AND pg_has_role(current_user, c.relowner, 'USAGE')
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype = 'e')   -- skip extension tables
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.relname);
  END LOOP;

  FOR api_role IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated') LOOP
    BEGIN
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', api_role);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', api_role);
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM %I', api_role);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', api_role);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', api_role);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM %I', api_role);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'hub_lockdown: could not fully revoke from %: %', api_role, SQLERRM;
    END;
  END LOOP;
END
$fn$;
SELECT hub_lockdown();
