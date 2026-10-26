-- Dashboards now have pages (for example Army, Air Force, Navy under one Ministry of Defence dashboard).
-- A dashboard saved before pages existed ({form_id, widgets}) becomes a single page named Overview.
-- The API also converts old configs when it reads them, so this only tidies what is stored. Safe to run twice.
UPDATE dashboards
SET config = jsonb_build_object(
      'pages', jsonb_build_array(jsonb_build_object(
        'id', 'main', 'title', 'Overview',
        'form_id', config -> 'form_id',
        'widgets', COALESCE(config -> 'widgets', '[]'::jsonb))))
WHERE NOT (config ? 'pages');
