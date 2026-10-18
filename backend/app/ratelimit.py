"""Fixed-window rate limits in Redis. If Redis is unreachable we fail open and log, never block users."""
import logging

from fastapi import Request
from redis.asyncio import Redis

from .config import settings
from .errors import Problem
from .logging_setup import client_ip

log = logging.getLogger("ratelimit")
redis: Redis = Redis.from_url(settings.redis_url, decode_responses=True, socket_timeout=1, socket_connect_timeout=1)


async def hit(key: str, limit: int, window: int) -> None:
    if not settings.rate_limit_enabled:
        return
    try:
        k = f"rl:{key}"
        n = await redis.incr(k)
        if n == 1:
            await redis.expire(k, window)
        if n > limit:
            ttl = await redis.ttl(k)
            raise Problem(429, "Too many requests. Please slow down.", code="rate_limited",
                          headers={"Retry-After": str(max(ttl, 1))})
    except Problem:
        raise
    except Exception as e:  # noqa: BLE001
        log.warning("rate limiter unavailable: %s", e)


def limit(name: str, per: int, window: int = 60):
    """Dependency: limit requests to `per` within `window` seconds for this client IP."""
    async def dep(request: Request):
        await hit(f"{name}:{client_ip(request)}", per() if callable(per) else per, window)
    return dep


async def ip_middleware(request: Request, call_next):
    if request.url.path.startswith("/tiles/") or request.url.path.startswith("/health"):
        return await call_next(request)   # tiles are many small requests; limit them at the edge
    try:
        await hit(f"ip:{client_ip(request)}", settings.rate_ip_per_min, 60)
    except Problem as p:
        from .errors import _resp
        return _resp(p)
    return await call_next(request)
