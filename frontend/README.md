# Geohub frontend

Web app and mobile collector for a spatial data collection and mapping platform: collect features in the field (offline),
edit them on a map with imagery, and publish datasets to a public hub where anyone can preview and download them.

React + TypeScript + Vite + MapLibre GL. The same build runs in the browser and, wrapped with Capacitor, as an Android app.

## Run it (no backend needed)

```bash
npm install
cp .env.example .env     # VITE_USE_MOCK=true by default
npm run dev              # http://localhost:5173
```

Sign in with `demo@geohub.test` / `demo`. The built-in mock API keeps data in your browser's localStorage and ships with
sample health facilities around Osogbo. Reset it by clearing site data.

## Screens

| Route | Screen |
|---|---|
| `/login` | Sign in |
| `/projects` | Project list, create project, publish a dataset |
| `/projects/:id/editor` | Web editor: layers, add/select/edit features, imagery and map-data upload (images and GeoJSON/KML/GPX/GeoPackage/Shapefile/CSV) |
| `/projects/:id/forms` and `/projects/:id/forms/:formId` | Form list and form builder |
| `/collect/:id` | Mobile collector: GPS capture, photos, offline queue, sync, conflicts |
| `/hub` and `/hub/:slug` | Public data hub and dataset page with downloads |

## Connect the real backend

The backend lives next to this app in the same repository (`../backend`).

1. Start it: `cd ../backend`, copy `.env.example` to `.env`, paste your Supabase connection string into `DATABASE_URL` (see `backend/README.md`, "Database: Supabase"), then `docker compose up --build` (API on http://localhost:8000).
2. In this folder's `.env` set `VITE_USE_MOCK=false` and `VITE_API_URL=http://localhost:8000`.
3. `npm run dev`, then choose **Create an account** on the sign-in screen.

How the app's types map to the API is in `docs/api-expectations.md`.

## Structure

```
src/
  lib/        api.ts (Api interface + HTTP client), sync.ts (offline engine), db.ts (IndexedDB), forms.ts, types.ts
  mock/       in-memory backend used when VITE_USE_MOCK=true
  components/ MapView, FormRenderer, Shell, ui (buttons, states, toasts)
  pages/      one file per screen
  styles/     app.css (design tokens and components)
scripts/      sync-test.ts (headless test of the offline sync rules)
docs/         api-expectations.md (frontend <-> backend mapping)
```

Every screen talks to the `Api` interface only. Swapping mock for real is a config change, not a code change.

## Offline sync (collector)

Records save to IndexedDB first and queue a change with a `change_id` (idempotent) and `base_version`. Sync pushes in batches,
keeps conflicts for the user to resolve ("keep theirs" or "keep mine"), uploads photos after their record exists on the server,
then pulls changes by cursor. It never overwrites unsynced local work. Run the checks with `npm run test:sync`.

## Android app (Capacitor)

```bash
npm run build
npx cap add android          # first time only
npm run cap:sync
npm run cap:android          # opens Android Studio
```

Add to `android/app/src/main/AndroidManifest.xml`: `ACCESS_FINE_LOCATION`, `ACCESS_COARSE_LOCATION`, `CAMERA`.
Set `VITE_API_URL` to an `https` address before building the app.

## Deploy the web app

Cloudflare Pages: build command `npm run build`, output directory `dist`. `public/_redirects` handles client-side routes.
Set the `VITE_*` variables in the Pages settings.

## Known limits (v0.1)

- Geometry editing is by redrawing; there are no vertex handles yet. Measure tool, bulk import UI and review/approve screens are not built.
- The editor loads all features as GeoJSON. Switch to the backend's vector tiles (`GET /projects/{id}/layers`) once datasets get large.
- The default basemap is OpenStreetMap's public tile server, which is not meant for heavy production use. Set `VITE_BASEMAP_URL`.
- Map and screens were type-checked and built, but have not been through browser testing on real devices yet.
