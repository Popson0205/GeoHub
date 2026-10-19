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


## Digitizing in the map editor

Edits are **staged**, not saved one by one. Draw as many features as you like, tag them, reshape, split, merge, move or delete, and nothing is sent until you press **Save all** (or Ctrl+S). The tool you picked stays on the whole time.

| Tool | Key | What it does |
| --- | --- | --- |
| Select | V | Click a feature. Shift-click (or turn on Multi-select) for several. |
| Point / Line / Polygon | P / L / G | Stays on after each feature. Double-click or Enter finishes a line or polygon (or click the green first point). A solid line, a dashed segment to the pointer and the live length or area show while you draw. Backspace removes the last point. |
| Reshape | R | Drag points, drag a midpoint to add one, right-click or double-click a point to remove it. |
| Move | M | Drag the selected features. |
| Split | S | Click a line to cut it in two at that spot. |
| Cut | C | Draw a line across lines or polygons to cut them. Cuts the selection, or whatever the line crosses. |
| Merge | | Joins selected lines (end to end) or polygons (touching or overlapping). |
| Duplicate, Delete | Del | Act on the selection. |

* **Tags for each new feature**: pick a preset (Building, Road, ...) or type tags once under Draw, and every new feature gets them. With several features selected, "Tags for all" adds tags to all of them.
* **Undo / Redo** (Ctrl+Z, Ctrl+Shift+Z) cover every staged step. New features are amber, edited ones blue, saved ones green.
* **Snapping** to nearby points while drawing and dragging (on by default).
* Unsaved work is kept on the device and restored if the page is refreshed or closed. If some changes fail to save (for example someone else edited the feature), the rest are saved and the failed ones stay staged.
* The logic lives in `src/lib/staging.ts` (edit history) and `src/lib/geoops.ts` (split, merge, move). `npm run test:digitize` checks both. Cutting and merging areas load Turf on first use only.


## Teams, contributors and publishing (shared maps)

A map can have people on it. Open **Team & stats** on a map card (or "Campaign portal" in the editor) to get the organiser's portal at `/maps/:id/portal`.

| Tab | Who | What it is for |
| --- | --- | --- |
| Contributors | everyone on the map | Leaderboard (features added, approved, waiting, rejected, edited, last active), activity chart, recent changes, CSV download for prizes. |
| Review | reviewers, owner (contributors see their own work and the reviewers' notes) | Filter by status or by person, look at features on the map, approve or reject in bulk with a note. |
| Team | owner manages | Invitation link (on/off, new link), promote to reviewer, remove people. Anyone can leave. |
| Campaign | owner | Turn the map into a mapping project or competition: goal, start and end, leaderboard on or off. |
| Publish | owner | Publish the **approved** features to the Data hub, one kind (points, lines or polygons) per dataset, with licence, visibility and contributor credits. Publish new versions later. |

* **Roles:** owner runs the map and publishes; reviewers approve work and can edit anything; contributors draw, and can change their own features until a reviewer approves them. Whatever the owner or a reviewer draws is approved straight away.
* **Joining:** people open the invitation link (`/join/:code`) or paste it on the Web mapping page. In mock mode, try `/join/ibadan-flood`.
* **Competition:** ranked by features added; rejected features do not count. With dates set, only features drawn inside the window count, and contributors cannot draw outside it.
* In the editor, features waiting for review are purple and rejected ones red. Contributors see approved and other people's features as locked.
* Mock mode ships a demo campaign ("Osogbo building mapathon") with a team and review work, so the portal has something to show.
* `npm run test:ui` renders the editor and portal pages against the mock backend (jsdom, with a stand-in for the WebGL map).


## Attribute table

Press **T**, or use **Table (n)** on the map, to open a table of every digitized feature under the map. One row per feature, one column per tag.

* **Select:** click a row to select the feature on the map (Shift for a range, Ctrl/Cmd to add, arrow keys to move, Ctrl+A for all). Picking a feature on the map scrolls its row into view. ⌖ zooms to a feature; "Zoom to selected" zooms to all of them.
* **Edit in place:** type in any cell and press Enter (Shift+Enter goes up) or leave the cell. Enter moves down the column. Emptying a cell removes the tag. Edits are staged like everything else, so Undo, Redo and **Save all** apply.
* **Set a value for many rows:** select rows, name a column, type a value and press Apply. **Add column** creates a column for a tag no feature has yet.
* **Find things:** search all values, filter by points, lines or areas, show only selected or only unsaved rows, sort any column (blanks always last), hide columns, download the shown rows as CSV.
* **Roles:** rows you may not change (someone else's, or already approved) are read-only. State and review status are shown for each row.
* Drag the top edge (or use the arrow keys on it) to resize. Only the rows in view are drawn, so large maps stay quick.

## Toolbar symbols

Every editing tool is a symbol (select, point, line, polygon, reshape, move, split, cut, merge, duplicate, delete, undo, redo, table, snap, multi-select). Hover for the name and shortcut; screen readers read the name. Save all shows a disk with the number of unsaved changes.
