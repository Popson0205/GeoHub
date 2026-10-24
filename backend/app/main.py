import httpx
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import errors, logging_setup, ratelimit
from .config import settings
from .db import lifespan as db_lifespan
from .db import pool
from .routers import auth, dashboards, datasets, features, forms, imagery, jobs, maps, media, projects, sharing, sync, tiles
from contextlib import asynccontextmanager

logging_setup.setup()


@asynccontextmanager
async def lifespan(app):
    async with db_lifespan(app):
        app.state.http = httpx.AsyncClient(timeout=15, limits=httpx.Limits(max_connections=100))
        yield
        await app.state.http.aclose()


P = settings.api_prefix.rstrip("/")

app = FastAPI(
    title="Mapping Hub API", version="1.0.0", lifespan=lifespan,
    docs_url=f"{P}/docs", redoc_url=f"{P}/redoc", openapi_url=f"{P}/openapi.json",
    description=("Backend for the web editor, mobile collector and public data hub. GeoJSON everywhere in EPSG:4326; "
                 "IDs are UUIDs; timestamps are UTC ISO 8601; lists use `?limit=&cursor=` and return "
                 "`{items, next_cursor}`; errors are `{type, title, status, detail, fields?}`."),
    responses={r: {"model": errors.ProblemOut, "description": "Problem"} for r in (401, 403, 404, 409, 422, 429)})
errors.install(app)

app.add_middleware(CORSMiddleware, allow_origins=[o.strip() for o in settings.cors_origins.split(",") if o.strip()],
                   allow_methods=["*"], allow_headers=["*"], expose_headers=["X-Request-ID", "Retry-After"])
app.middleware("http")(ratelimit.ip_middleware)
app.middleware("http")(logging_setup.access_middleware)

for r in (auth.router, auth.me_router, projects.router, forms.router, dashboards.router, features.router, sync.router, media.router,
          imagery.router, tiles.router, datasets.router, jobs.router, maps.router, sharing.router):
    app.include_router(r, prefix=P)


@app.get(f"{P}/health", tags=["meta"], summary="Liveness")
async def health():
    return {"ok": True}


@app.get(f"{P}/health/ready", tags=["meta"], summary="Readiness: database, Redis and storage")
async def ready():
    import anyio
    from . import storage
    checks = {}
    try:
        async with pool.connection() as c:
            await c.execute("SELECT 1")
        checks["database"] = True
    except Exception:  # noqa: BLE001
        checks["database"] = False
    try:
        checks["redis"] = bool(await ratelimit.redis.ping())
    except Exception:  # noqa: BLE001
        checks["redis"] = False
    try:
        await anyio.to_thread.run_sync(lambda: storage.internal.head_bucket(Bucket=settings.s3_bucket))
        checks["storage"] = True
    except Exception:  # noqa: BLE001
        checks["storage"] = False
    from fastapi.responses import JSONResponse
    return JSONResponse({"ok": all(checks.values()), **checks}, status_code=200 if all(checks.values()) else 503)


# ---- built web app (single-service deploy) ----
# When WEB_DIR points at the frontend's `dist` folder, serve it from the same origin: real files first, then
# index.html for client-side routes. API routes live under API_PREFIX (e.g. /api) so they never clash with them.
if settings.web_dir:
    from pathlib import Path

    from fastapi import HTTPException
    import html as _html
    import re

    from fastapi.responses import FileResponse, HTMLResponse

    _web = Path(settings.web_dir).resolve()
    # A redeploy must show up without anyone clearing their cache. Built files under /assets carry a hash in their
    # name, so they can be kept forever; everything else (the page, the service worker, the manifest) is re-checked
    # on every load (a cheap "not modified" answer when nothing changed).
    _FOREVER = {"Cache-Control": "public, max-age=31536000, immutable"}
    _REVALIDATE = {"Cache-Control": "no-cache"}
    _SHARE_PATH = re.compile(r"^f/(?:.*-)?([0-9a-f]{32})/?$")

    async def _share_page(index: Path, token: str) -> str | None:
        """index.html with the form's name as the page title and link preview (WhatsApp, Slack, ...), so a shared
        link reads as the form and not as the app. Any problem falls back to the plain page."""
        try:
            async with pool.connection() as c:
                cur = await c.execute(
                    "SELECT v.name, p.name AS project FROM forms f JOIN projects p ON p.id = f.project_id "
                    "JOIN form_versions v ON v.form_id = f.id AND v.version = f.version "
                    "WHERE f.share_token = %s AND f.share_mode = 'public' AND f.version > 0", (token,))
                row = await cur.fetchone()
            if not row:
                return None
            name, project = _html.escape(row["name"], quote=True), _html.escape(row["project"], quote=True)
            desc = f"Fill in this form for {project}."
            tags = (f'<title>{name}</title><meta property="og:title" content="{name}">'
                    f'<meta property="og:description" content="{desc}"><meta property="og:type" content="website">'
                    f'<meta name="description" content="{desc}">')
            page = re.sub(r"<title>.*?</title>", "", index.read_text(encoding="utf-8"), flags=re.S)
            return page.replace("</head>", tags + "</head>", 1)
        except Exception:  # noqa: BLE001
            return None

    @app.get("/{full_path:path}", include_in_schema=False)
    async def web_app(full_path: str):
        if P and ("/" + full_path).startswith(P + "/"):
            raise HTTPException(404)
        f = (_web / full_path).resolve()
        if full_path and f.is_file() and _web in f.parents:
            return FileResponse(f, headers=_FOREVER if full_path.startswith("assets/") else _REVALIDATE)
        if full_path.startswith("assets/"):
            raise HTTPException(404)   # a file from an older build: say so, never answer with the page
        m = _SHARE_PATH.match(full_path)
        if m:
            page = await _share_page(_web / "index.html", m.group(1))
            if page:
                return HTMLResponse(page, headers=_REVALIDATE)
        return FileResponse(_web / "index.html", headers=_REVALIDATE)
elif not P:
    @app.get("/", include_in_schema=False)
    async def root():
        from fastapi.responses import RedirectResponse
        return RedirectResponse("/docs")
