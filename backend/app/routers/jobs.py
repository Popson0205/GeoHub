from uuid import UUID

from fastapi import APIRouter, Depends, Request

from .. import ratelimit, storage
from ..config import settings
from ..db import get_conn
from ..deps import optional_user, require_role
from ..errors import Problem
from ..logging_setup import client_ip
from ..schemas import JobOut

router = APIRouter(tags=["jobs"])


def job_out(j: dict) -> dict:
    res = j["result"]
    if j["kind"] == "export" and j["status"] == "done" and res and res.get("storage_key"):
        res = {"filename": res["filename"], "format": res.get("format"), "size": res.get("size"),
               "download_url": storage.presign_get(res["storage_key"], res["filename"], expires=3600)}
    return {**j, "result": res}


@router.get("/jobs/{job_id}", response_model=JobOut)
async def get_job(job_id: UUID, request: Request, user=Depends(optional_user), conn=Depends(get_conn)):
    """Progress, and when done the result. Export jobs return a signed `download_url` (valid one hour).
    Exports of public datasets can be polled without logging in."""
    cur = await conn.execute("SELECT * FROM jobs WHERE id = %s", (job_id,))
    j = await cur.fetchone()
    if not j:
        raise Problem(404, "Job not found.", code="not_found")
    if j["public"]:
        if not user:
            await ratelimit.hit(f"hubread:{client_ip(request)}", settings.rate_anon_read_per_min, 60)
    else:
        if not user:
            raise Problem(401, "Sign in to continue.", code="unauthenticated")
        if j["project_id"]:
            await require_role(conn, j["project_id"], user["id"])
        elif j["created_by"] != user["id"]:
            raise Problem(404, "Job not found.", code="not_found")
    return job_out(j)
