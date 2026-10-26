# Geohub

A spatial data platform made of three separate tools that share one login:

| Tool | What it is | Routes |
|---|---|---|
| **Web mapping** | A standalone mapping tool, like OpenStreetMap's editors. Draw points, lines and areas with free-form tags over imagery you add by tile URL (`https://host/{z}/{x}/{y}.png`) or by uploading a GeoTIFF/JPEG/PNG. Import GeoJSON, KML or GPX, export GeoJSON. Needs no forms and no projects. | `/maps`, `/maps/:id` |
| **Data collection** | Projects with a form builder, offline mobile collector (GPS, photos), review of collected data and publishing. | `/collect`, `/collect/:project`, `/collect/:project/forms`, `/collect/:project/review` |
| **Dashboards** | Its own app over the data a project has collected. A gallery of dashboards and a Reports page, and each dashboard opens in a full-screen workspace: a left toolbar (Add element, View, Data sources, Theme, Time and region, Save) and a canvas. Eleven kinds of element, pages, a side column, themes, a date range and click-to-filter. Reports are printable snapshots. A dashboard can be shared by a public link (`/d/:token`): read-only, approved records only, and only the fields the dashboard draws. | `/dashboards`, `/dashboards/reports`, `/dashboards/:id` |
| **Data hub** | Public catalogue where anyone can preview and download published datasets. | `/hub`, `/hub/:slug` |

| Folder | What | Stack |
|---|---|---|
| [`frontend/`](frontend) | Web editor, mobile collector (Android via Capacitor) and public data hub | React, TypeScript, Vite, MapLibre GL |
| [`backend/`](backend) | REST API, background jobs, tiles, exports | FastAPI, Supabase (PostgreSQL + PostGIS), Redis + RQ, S3-compatible storage, Martin, TiTiler |

## Run everything locally

You need Docker, Node 20+ and a [Supabase](https://supabase.com) project (the database).

```bash
# 1. backend (API on http://localhost:8000, docs at /docs)
cd backend
cp .env.example .env
# edit .env: paste your Supabase "Session pooler" connection string into DATABASE_URL
# (backend/README.md, "Database: Supabase", has the 5 setup steps)
docker compose up --build

# 2. frontend (http://localhost:5173), in a second terminal
cd frontend
npm install
cp .env.example .env
# edit .env: VITE_USE_MOCK=false
npm run dev
```

Open http://localhost:5173, choose **Create an account**, then create a project, a form, and start collecting.
With `VITE_USE_MOCK=true` (the default) the frontend runs alone against an in-browser mock, no backend needed.

## How the two halves fit together

- The frontend only talks to the backend through `frontend/src/lib/api.ts`. The mapping between the UI's types and the
  API's responses is documented in [`frontend/docs/api-expectations.md`](frontend/docs/api-expectations.md).
- `backend/openapi.json` is the API's source of truth. Regenerate it after changing routes (command in `backend/README.md`).
- Backend `CORS_ORIGINS` must include wherever the frontend is served from (already set for local development and
  the Android app).

## Deploying

**One service (Railway or any Docker host):** the `Dockerfile` in the repo root builds the frontend and the API into a single
image. The API is served under `/api` and the web app at `/`. Set `API_PREFIX=/api` and `WEB_DIR` (already set in that
Dockerfile) and `PUBLIC_BASE_URL=https://your-domain/api`.

**Separately:**

- **Database**: Supabase. **Backend**: any Docker host (Railway, Render, Fly). See "Deploy" in [`backend/README.md`](backend/README.md).
- **Frontend**: Cloudflare Pages (or any static host). Root directory `frontend`, build command `npm run build`,
  output directory `dist`, and set `VITE_USE_MOCK=false` and `VITE_API_URL=https://your-api`.

## CI

`.github/workflows/ci.yml` runs the backend test suite and the frontend build plus offline-sync tests on every push.
