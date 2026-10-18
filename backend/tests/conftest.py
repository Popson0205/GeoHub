"""Integration tests run against real PostGIS, Redis and an S3 stand-in (moto server on :5555).
Locally: see README "Running the tests". CI starts the same services."""
import os
import uuid
from pathlib import Path

import boto3
import httpx
import pytest

env_file = Path(__file__).resolve().parent.parent / ".env.test"
if env_file.exists():
    for line in env_file.read_text().splitlines():
        if line.strip() and not line.startswith("#"):
            k, _, v = line.partition("=")
            os.environ.setdefault(k.strip(), v.strip())

from fastapi.testclient import TestClient  # noqa: E402
from redis import Redis  # noqa: E402

from app.config import settings  # noqa: E402
from app.main import app  # noqa: E402


@pytest.fixture(scope="session")
def tile_calls():
    return []


@pytest.fixture(scope="session")
def client(tile_calls):
    s3 = boto3.client("s3", endpoint_url=settings.s3_endpoint, aws_access_key_id="test", aws_secret_access_key="test",
                      region_name="us-east-1")
    try:
        s3.create_bucket(Bucket=settings.s3_bucket)
    except Exception:  # noqa: BLE001
        pass

    def upstream(request: httpx.Request) -> httpx.Response:     # stands in for Martin and TiTiler
        tile_calls.append(request)
        if "feature_tiles" in request.url.path:
            return httpx.Response(200, content=b"MVT-BYTES")
        return httpx.Response(200, content=b"\x89PNG-BYTES")

    with TestClient(app) as c:
        app.state.http = httpx.AsyncClient(transport=httpx.MockTransport(upstream))
        yield c


@pytest.fixture(autouse=True)
def fresh_rate_limits():
    Redis.from_url(settings.redis_url).flushdb()


def uid() -> str:
    return uuid.uuid4().hex[:10]


class Actor:
    def __init__(self, client, name="Tester"):
        self.c, self.email, self.password = client, f"{uid()}@example.com", "correct-horse-battery"
        r = client.post("/auth/register", json={"email": self.email, "password": self.password, "name": name})
        assert r.status_code == 201, r.text
        self.tokens = r.json()
        self.id = self.tokens["user"]["id"]
        self.h = {"Authorization": f"Bearer {self.tokens['access_token']}"}

    def get(self, url, **kw): return self.c.get(url, headers=self.h, **kw)
    def post(self, url, **kw): return self.c.post(url, headers=self.h, **kw)
    def patch(self, url, **kw): return self.c.patch(url, headers=self.h, **kw)
    def put(self, url, **kw): return self.c.put(url, headers=self.h, **kw)
    def delete(self, url, **kw): return self.c.delete(url, headers=self.h, **kw)


@pytest.fixture
def actor(client):
    def make(name="Tester"):
        return Actor(client, name)
    return make


FIELDS = [
    {"id": "type", "label": "Type", "type": "choice", "required": True, "choices": ["Clinic", "Hospital", "Pharmacy"]},
    {"id": "beds", "label": "Beds", "type": "number"},
    {"id": "services", "label": "Services", "type": "multi_choice", "choices": ["ER", "Maternity", "Lab"], "max_items": 3},
    {"id": "opened", "label": "Opened", "type": "date"},
    {"id": "photos", "label": "Photos", "type": "photo", "max_items": 3},
]


def pt(lon=3.39, lat=6.52):
    return {"type": "Point", "coordinates": [lon, lat]}


@pytest.fixture
def project(actor):
    """An owner, a project, and a published point form."""
    owner = actor("Owner")
    pid = owner.post("/projects", json={"name": "Health map"}).json()["id"]
    form = owner.post(f"/projects/{pid}/forms", json={"name": "Facilities", "geometry_type": "point", "fields": FIELDS}).json()
    r = owner.post(f"/forms/{form['id']}/publish")
    assert r.status_code == 200, r.text

    class P:
        pass
    p = P()
    p.owner, p.id, p.form_id = owner, pid, form["id"]

    def add(role, name=None):
        a = actor(name or role.title())
        r = owner.post(f"/projects/{pid}/members", json={"email": a.email, "role": role})
        assert r.status_code == 201, r.text
        return a
    p.add = add
    return p


def change(p, op="create", fid=None, **kw):
    """Build a sync change."""
    base = {"change_id": str(uuid.uuid4()), "id": fid or str(uuid.uuid4()), "op": op, "base_version": 0}
    if op == "create":
        base.update({"form_id": p.form_id, "geometry": pt(), "properties": {"type": "Clinic", "beds": 5}})
    base.update(kw)
    return base
