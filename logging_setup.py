import json
import logging
import time
import uuid

from .config import settings


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        out = {"ts": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(record.created)) + "Z",
               "level": record.levelname, "logger": record.name, "msg": record.getMessage()}
        out.update(getattr(record, "ctx", {}))
        if record.exc_info:
            out["exc"] = self.formatException(record.exc_info)
        return json.dumps(out, default=str)


def setup():
    h = logging.StreamHandler()
    h.setFormatter(JsonFormatter())
    root = logging.getLogger()
    root.handlers[:] = [h]
    root.setLevel(settings.log_level)
    logging.getLogger("uvicorn.access").disabled = True   # replaced by the access log middleware below
    if settings.sentry_dsn:
        import sentry_sdk
        sentry_sdk.init(dsn=settings.sentry_dsn, environment=settings.env, traces_sample_rate=0.0)


access_log = logging.getLogger("access")


async def access_middleware(request, call_next):
    rid = request.headers.get("x-request-id") or uuid.uuid4().hex[:16]
    request.state.request_id, request.state.user_id = rid, None
    start = time.perf_counter()
    status = 500
    try:
        response = await call_next(request)
        status = response.status_code
        response.headers["X-Request-ID"] = rid
        return response
    finally:
        access_log.info("request", extra={"ctx": {
            "request_id": rid, "method": request.method, "path": request.url.path, "status": status,
            "ms": round((time.perf_counter() - start) * 1000, 1), "user_id": request.state.user_id,
            "ip": client_ip(request)}})


def client_ip(request) -> str:
    if settings.trust_proxy:
        fwd = request.headers.get("cf-connecting-ip") or request.headers.get("x-forwarded-for", "")
        if fwd:
            return fwd.split(",")[0].strip()
    return request.client.host if request.client else "unknown"
