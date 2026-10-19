# Mapping Hub backend

> Part of the Geohub monorepo. The web app and mobile collector that use this API are in [`../frontend`](../frontend).

API for the web editor, mobile collector and public data hub. Implements the
[Backend API Contract and Data Model](docs/CONTRACT_NOTES.md) handoff.

**FastAPI · Supabase (PostgreSQL + PostGIS) · Redis + RQ workers · S3-compatible storage · Martin (vector tiles) · TiTiler (imagery) · GDAL**

`openapi.json` (OpenAPI 3.1) is the frontend's source of truth. It is regenerated from the code:
`python -c "import json; from app.main import app; json.dump(app.openapi(), open('openapi.json','w'), indent=2)"`
Live docs are at `/docs` when the API is running.

## Database: Supabase

The database is a Supabase project. The API talks to it directly over Postgres (psycopg); it does **not** use
Supabase Auth, the Data API or the client libraries, and keeps its own users and JWTs.

1. Create a project at supabase.com (keep the database password).
2. **Connect → Session pooler** (port 5432) and copy the connection string into `DATABASE_URL` in `.env`, keeping
   `?sslmode=require`. The direct connection also works but is IPv6-only; many hosts (and Docker on some networks)
   cannot reach it. **Do not use the transaction pooler (port 6543)**: the migration runner holds an advisory lock for
   the length of its session.
3. Start the API. It enables PostGIS and applies `migrations/` itself on first start (the `postgres` role can create the extension).
4. **Settings → Data API → turn it off.** Supabase otherwise serves every table in `public` over a public REST
   endpoint. Migration `003_supabase_lockdown.sql` also turns on row-level security with no policies and revokes the
   `anon`/`authenticated` roles' access, and `app/db.py` re-applies that after every migration run, so tables added later
   are closed too. Belt and braces: both layers should be on.
5. Connection budget: the API uses up to `DB_POOL_MAX` connections (default 10), the worker and backup job one each.
   Stay below your plan's limit.
6. Martin (vector tiles) connects to the same database through `DATABASE_URL`; docker-compose passes it through.

Offline or on a plane: `docker compose -f docker-compose.yml -f docker-compose.localdb.yml up --build` swaps in a
throwaway local PostGIS.

## Run it locally

```bash
cp .env.example .env     # fill in DATABASE_URL from Supabase
docker compose up --build
```

| URL | What |
|---|---|
| http://localhost:8000/docs | API docs (try requests here) |
| http://localhost:9001 | MinIO console (`minio` / `minio12345`), bucket `hub` is created for you |
| http://localhost:8000/health/ready | Checks database, Redis and storage |

Migrations in `migrations/` apply automatically when the API starts. Martin and TiTiler are internal:
the browser only ever talks to the API (see [Tiles](#tiles)). With `JOBS_INLINE=true` jobs run inside the API
process, so you can develop without the worker container.

## Running the tests

The suite is integration tests against real PostGIS, Redis and an S3 stand-in. GDAL (`gdal-bin`) and the
PostgreSQL client tools must be installed.

```bash
pip install -r requirements-dev.txt
cp .env.test.example .env.test           # points at localhost services
python -m moto.server -p 5555 &          # local S3
createdb hub_test                        # PostGIS-enabled Postgres and Redis running locally
pytest -q
```
GitHub Actions (`.github/workflows/ci.yml`) runs the same suite on every push.

## Deploy

Any host that runs Docker works. Typical setup (for example Railway or Render):

| Service | How |
|---|---|
| **api** | this repo's `Dockerfile`; it honours `$PORT` and runs migrations at startup |
| **worker** | same image, start command `rq worker default --url $REDIS_URL` |
| **Database** | your Supabase project (see above). Set `DATABASE_URL` on api, worker, backup and Martin |
| **Redis** | any Redis 7 |
| **Martin** | `ghcr.io/maplibre/martin` with `martin/martin.yaml` (set the connection string). Private network only |
| **TiTiler** | `ghcr.io/developmentseed/titiler` with the S3 credentials as env vars. Private network only |
| **Object storage** | S3, Cloudflare R2, Backblaze B2 or MinIO. **Turn on bucket versioning** |
| **backup** | a daily scheduled job running `python -m app.ops.backup` |

Production checklist:

1. `ENV=prod` and a random `JWT_SECRET` of 32+ characters. The API refuses to start otherwise.
2. `TRUST_PROXY=true` when behind Cloudflare or a platform proxy, so rate limits see real client IPs.
3. `CORS_ORIGINS` set to your app, hub and mobile origins only (Capacitor: `capacitor://localhost`, `http://localhost`).
4. `PUBLIC_BASE_URL` is the public API URL (used inside tile URLs). `S3_PUBLIC_ENDPOINT` is the storage URL that
   browsers and phones can reach (used in presigned upload and download links).
   On Cloudflare R2 set `S3_ENDPOINT` and `S3_PUBLIC_ENDPOINT` to `https://<account>.r2.cloudflarestorage.com` and
   `S3_REGION=auto` (a region name, not a URL).
5. **Bucket CORS.** Browsers upload imagery and photos straight to storage, so the bucket must allow your app
   origins to `PUT` and must expose the `ETag` header (needed to finish multipart uploads):
   ```json
   [{"AllowedOrigins": ["https://app.example.org"], "AllowedMethods": ["PUT", "GET"],
     "AllowedHeaders": ["*"], "ExposeHeaders": ["ETag"], "MaxAgeSeconds": 3600}]
   ```
6. Optional: `SENTRY_DSN` for error tracking; `SMTP_*` for invitation emails (without SMTP they are written to the log).

### Backups and restore test
Supabase makes its own backups on paid plans (daily, with point-in-time recovery as an add-on); `app.ops.backup` is an
extra copy you control, stored in your own bucket. `python -m app.ops.backup` writes `backups/hub-<timestamp>.dump` to the bucket and prunes old ones
(`BACKUP_RETENTION_DAYS`, default 30). `python -m app.ops.restore_test` restores the newest backup into a scratch
database, checks the core tables are readable, then drops it. It exits non-zero on failure, so schedule it weekly and
alert on failure. On Supabase you cannot normally create databases, so point `RESTORE_TEST_DATABASE_URL` at a scratch Postgres with PostGIS
(for example the local one from `docker-compose.localdb.yml`).
To restore for real: `pg_restore --no-owner --clean --dbname "$DATABASE_URL" hub.dump`.

## How the main flows work

### Sync (mobile collector)
1. The phone creates features with its own UUIDs and queues every change with a fresh `change_id`.
2. `POST /sync/push` takes up to 200 changes and answers each one: `applied` (new `version`), `conflict`
   (with `server` and `client` versions) or `rejected` (with `code` and field-level `fields`). One bad change never fails the batch.
3. **Retries are safe.** The same `(feature id, change_id)` is applied once; replays return the stored result.
4. A change carries `base_version`. If the server has moved on: edits to *different* properties with no geometry
   change on either side are merged (`applied`, `merged: true`); anything else returns `conflict` and the app lets
   the user choose, then resubmits against the server's version.
5. Deletes win over later edits (`rejected`, code `FEATURE_DELETED`) until an admin calls `POST /features/{id}/restore`.
6. `GET /sync/pull?project_id=&cursor=` returns changes in per-project sequence order, never client clock order.
   Store the returned `next_cursor` and ask again from it. Deletions arrive as `op: "delete"`.
7. `GET /projects/{id}/bundle` gives published forms, settings and the features in the user's assigned area for
   offline use, plus a `cursor` to start pulling from.
8. Photos: `POST /media/upload-url` → `PUT` bytes to the URL → `POST /media/{id}/complete` (needs the feature to exist
   already). Calling `upload-url` again with the same id gives a fresh URL, which is how interrupted uploads resume.
   Originals are kept; a 2048 px web copy is made in the worker. Limit 10 MB.

Why the sequence can be trusted: each feature write increments `projects.seq_counter` while holding that row's lock
until commit, so commits are serialised per project and a cursor can never skip a change that commits late.

### Roles
| Role | Can do |
|---|---|
| owner | everything, including delete project, publish datasets, change admins |
| admin | members (collectors/viewers), forms, imagery, import, review and approve features |
| collector | create features; edit and delete **own** features; read the whole project |
| viewer | read only |

Roles are per project. Non-members get `404`, so the existence of a project is not revealed.

### Tiles
Martin and TiTiler are never exposed. `GET /projects/{id}/layers` lists the project's map layers with stable tile
URLs; each carries a short-lived `?sig=` token (1 hour, bound to the project) so MapLibre can load tiles without
custom headers. Tile routes also accept `Authorization: Bearer` or `?access_token=`. Vector tiles have one layer,
`features`, with attributes `id`, `status`, `version` and `props` (JSON text). Tiles are sent with
`Cache-Control: private`, so do not cache them on a shared CDN.

### Imagery and other uploads
`POST /projects/{id}/imagery` takes any raster GDAL can read: `.tif .tiff .jpg .jpeg .png .webp .gif .bmp .jp2 .j2k .img .asc`.
It is converted to a Cloud-Optimised GeoTIFF and served as tiles. Whether `.jp2`, `.webp` etc. work depends on the
drivers in the GDAL build; an unreadable file fails with `not_a_raster` and a plain message.
Plain JPEG/PNG/GIF/BMP files carry no coordinates. Send `bounds: [west, south, east, north]` (and `crs`, default
`EPSG:4326`) with the upload and the image is placed there; without it the job fails with `no_georeference`.
`.vrt` is refused on purpose (it can reference arbitrary files on the server).

Map data is not imagery. `.geojson`, `.json`, `.kml`, `.gpx`, `.gpkg`, `.gml`, a zipped Shapefile (`.zip`) and `.csv` go to
`POST /projects/{id}/import`, which validates every row against a form and keeps the good ones. The imagery endpoint
answers vector filenames with code `use_import`. Non-GeoJSON vector files are converted with `ogr2ogr` (first layer
with geometry, reprojected to WGS84).

### Public hub
`POST /projects/{id}/datasets` (owner) creates a dataset and takes **snapshot v1** as a job. Only `approved`
features are included unless you pass `statuses: ["submitted","approved"]`. Versions are immutable copies; publishing
again with `POST /datasets/{slug}/versions` never changes earlier versions. Photos are not published in v1.
Exports (`geojson`, `gpkg`, `shp`, `csv`) are jobs; identical exports are generated once and reused, and each request
is counted as a download of that version. Shapefile zips include `field_mapping.csv` (10-character name limit) and a
README. CSV points have `longitude`, `latitude`; lines and areas have `wkt`. Anonymous users are rate-limited.

## Project layout
```
app/
  main.py            app, middleware, health        routers/   one module per area of the contract
  config.py          settings from env              services/  feature rules, form validation, geometry
  db.py              pool, migrations, seq counter  worker/    background jobs (imagery, snapshot, export, import, photos)
  errors.py          RFC 7807 problems              ops/       backup and restore test
migrations/          SQL, applied in order          martin/    Martin config
tests/               integration tests              docs/      CONTRACT_NOTES.md
```

## Not built yet
Password reset and email verification; multi-layer or sidecar-file imagery (world files, `.prj`);  per-dataset API keys; virus scanning of uploads; tile
caching; migrating to Alembic if schema changes become frequent (the runner in `app/db.py` is deliberately simple).


## Shared maps, contributors and publishing

Migration `006_collaboration.sql` adds what a mapping campaign needs. Everything is under `/maps` (see `openapi.json`).

* **People:** `map_members` (reviewer or contributor; the owner is `workspace_maps.owner_id`). Joining is by an unguessable link code: `GET/POST /join/{code}`. `require_map(conn, map_id, user_id, minimum)` returns the map with the caller's `role`; people with no role get 404.
* **Authorship and review:** every feature stores `created_by`, `updated_by` and a `status` (`submitted`, `approved`, `rejected`). Features drawn by the owner or a reviewer are approved at once; a contributor's feature waits, and changing it sends it back to `submitted`. Contributors can change only their own features, and not once approved. `POST /maps/{id}/features/review` (reviewers) approves or rejects up to 1000 at a time.
* **Campaigns:** `is_campaign`, `goal`, `starts_at`, `ends_at`, `competition` on the map. Outside the window contributors get 409 `campaign_closed` on writes; the owner and reviewers are exempt.
* **Portal data:** `GET /maps/{id}/contributors` (per-person counts, ranked by features added with rejected ones excluded, restricted to the campaign window), `/activity`, `/members`.
* **Publishing:** `POST /maps/{id}/publish` (owner) creates a Data hub dataset (`datasets.map_id`, `map_geometry`) from the **approved** features of one kind. Tags become text fields (names are made safe and unique). `POST /datasets/{slug}/versions` publishes the next version. Contributors are credited in `dataset_versions.contributors` unless `credit_contributors` is false. Private map datasets are visible to map members only.
* Tests: `tests/test_collaboration.py`.
