"""Errors from people's browsers. Logged like server errors and, when SENTRY_DSN is set, sent to Sentry,
so a crash someone hits in the field is seen without them having to describe it."""
import logging
from typing import Literal

from fastapi import APIRouter, Depends, Request
from fastapi.security import HTTPAuthorizationCredentials
from pydantic import BaseModel, Field

from .. import ratelimit
from ..config import settings
from ..db import get_conn
from ..deps import _user_from_token, bearer
from ..errors import Problem
from ..logging_setup import client_ip

router = APIRouter(tags=["meta"])
log = logging.getLogger("client")


class ClientErrorIn(BaseModel):
    ref: str = Field(max_length=40, pattern=r"^[A-Za-z0-9-]+$", description="Short code shown to the person, to quote to support")
    kind: Literal["render", "error", "unhandledrejection", "chunk"]
    name: str = Field("Error", max_length=120)
    message: str = Field(max_length=1000)
    stack: str | None = Field(None, max_length=8000)
    component_stack: str | None = Field(None, max_length=4000)
    url: str = Field(max_length=1000, description="The page, without its query string")
    release: str | None = Field(None, max_length=64)
    user_agent: str | None = Field(None, max_length=400)
    offline: bool = False


async def _who(request: Request, creds: HTTPAuthorizationCredentials | None = Depends(bearer), conn=Depends(get_conn)):
    """The signed-in person when the token is still good; an expired session must not stop a report."""
    if not creds:
        return None
    try:
        return await _user_from_token(conn, creds.credentials, request)
    except Problem:
        return None


@router.post("/client-errors", status_code=202, summary="Report an error from the web app",
             dependencies=[Depends(ratelimit.limit("client-errors", 20, 60))])
async def report(body: ClientErrorIn, request: Request, user=Depends(_who)):
    ctx = {**body.model_dump(exclude={"stack", "component_stack"}), "user_id": str(user["id"]) if user else None,
           "ip": client_ip(request), "request_id": getattr(request.state, "request_id", None)}
    log.warning("browser error: %s: %s", body.name, body.message, extra={"ctx": {**ctx, "stack": body.stack}})
    if settings.sentry_dsn:
        import sentry_sdk
        with sentry_sdk.new_scope() as scope:
            scope.set_tag("source", "browser")
            scope.set_tag("kind", body.kind)
            scope.set_tag("ref", body.ref)
            if body.release:
                scope.set_tag("release", body.release)
            if user:
                scope.set_user({"id": str(user["id"])})
            scope.set_context("browser_error", {"url": body.url, "user_agent": body.user_agent, "offline": body.offline,
                                                "stack": body.stack, "component_stack": body.component_stack})
            scope.fingerprint = ["browser", body.name, body.message[:200]]
            sentry_sdk.capture_message(f"{body.name}: {body.message}", level="error")
    return {"ref": body.ref, "received": True}
