import base64
import json
from typing import Generic, TypeVar

from pydantic import BaseModel

from .errors import Problem

T = TypeVar("T")


class Page(BaseModel, Generic[T]):
    items: list[T]
    next_cursor: str | None = None


def encode_cursor(**kw) -> str:
    return base64.urlsafe_b64encode(json.dumps(kw).encode()).decode().rstrip("=")


def decode_cursor(cursor: str | None) -> dict:
    if not cursor:
        return {}
    try:
        return json.loads(base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)))
    except Exception:  # noqa: BLE001
        raise Problem(400, "Invalid cursor.", code="invalid_cursor")


def page_from_offset(rows: list, limit: int, offset: int) -> tuple[list, str | None]:
    """Expects rows fetched with LIMIT limit+1."""
    more = len(rows) > limit
    return rows[:limit], encode_cursor(o=offset + limit) if more else None
