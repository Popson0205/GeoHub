import logging

import anyio
from psycopg.types.json import Jsonb
from redis import Redis
from rq import Queue

from .config import settings

log = logging.getLogger("jobs")
_queue: Queue | None = None


def _q() -> Queue:
    global _queue
    if _queue is None:
        _queue = Queue("default", connection=Redis.from_url(settings.redis_url))
    return _queue


async def create_job(conn, kind: str, params: dict, *, project_id=None, created_by=None, public=False,
                     status="queued", result=None) -> dict:
    cur = await conn.execute(
        "INSERT INTO jobs (kind, params, project_id, created_by, public, status, progress, result) "
        "VALUES (%s, %s, %s, %s, %s, %s, %s, %s) RETURNING *",
        (kind, Jsonb(params), project_id, created_by, public, status, 100 if status == "done" else 0,
         Jsonb(result) if result is not None else None))
    return await cur.fetchone()


async def dispatch(conn, job: dict):
    """Commit first so the worker can see the row, then hand the job to the queue."""
    await conn.commit()
    if job["status"] != "queued":
        return
    job_id = str(job["id"])
    if settings.jobs_inline:
        from .worker.tasks import run_job
        await anyio.to_thread.run_sync(run_job, job_id)
    else:
        await anyio.to_thread.run_sync(lambda: _q().enqueue("app.worker.tasks.run_job", job_id, job_timeout=7200))


async def dispatch_photo(media_id: str):
    if settings.jobs_inline:
        from .worker.tasks import process_photo
        await anyio.to_thread.run_sync(process_photo, media_id)
    else:
        await anyio.to_thread.run_sync(lambda: _q().enqueue("app.worker.tasks.process_photo", media_id))
