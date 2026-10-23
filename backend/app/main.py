import httpx
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import errors, logging_setup, ratelimit
from .config import settings
from .db import lifespan as db_lifespan
from .db import pool
from .routers import auth, datasets, features, forms, imagery, jobs, maps, media, projects, sharing, sync, tiles
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

for r in (auth.router, auth.me_router, projects.router, forms.router, features.router, sync.router, media.router,
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
    from fastapi.responses import FileResponse

    _web = Path(settings.web_dir).resolve()

    @app.get("/{full_path:path}", include_in_schema=False)
    async def web_app(full_path: str):
        if P and ("/" + full_path).startswith(P + "/"):
            raise HTTPException(404)
        f = (_web / full_path).resolve()
        if full_path and f.is_file() and _web in f.parents:
            return FileResponse(f)
        return FileResponse(_web / "index.html")
elif not P:
    @app.get("/", include_in_schema=False)
    async def root():
        from fastapi.responses import RedirectResponse
        return RedirectResponse("/docs")
