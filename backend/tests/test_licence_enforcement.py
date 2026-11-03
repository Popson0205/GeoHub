from datetime import date, timedelta

import psycopg
import pytest

from app.config import settings
from conftest import Actor, pt, uid


@pytest.fixture
def outbox(monkeypatch):
    sent = []

    async def fake(to, subject, body, *, action=None, key=None, raise_errors=False, brand=None):
        sent.append({"to": to, "subject": subject, "body": body, "action": action})
        return True
    from app import reminders, signup
    from app.routers import admin, auth, org
    for m in (admin, auth, org, reminders, signup):
        monkeypatch.setattr(m, "send_email", fake)
    return sent


def ends(org_id, days_from_today: int | None, suspended: bool = False):
    with psycopg.connect(settings.database_url, autocommit=True) as c:
        c.execute("UPDATE organizations SET subscription_ends = current_date + %s, suspended_at = CASE WHEN %s THEN now() END "
                  "WHERE id = %s", (days_from_today, suspended, org_id))


def test_grace_then_read_only(client, project):
    o = project.owner
    ends(o.org_id, -3)
    me = o.get("/me").json()["org"]["licence"]
    assert me["status"] == "grace" and me["grace_ends"] == (date.today() + timedelta(days=11)).isoformat()
    assert o.post("/projects", json={"name": "Still fine"}).status_code == 201       # full use during grace

    ends(o.org_id, -15)
    assert o.get("/me").json()["org"]["licence"]["status"] == "expired"
    assert o.get("/projects").status_code == 200 and o.get("/org").status_code == 200
    r = o.post("/projects", json={"name": "Blocked"})
    assert r.status_code == 403 and r.json()["code"] == "licence_expired" and "read-only" in r.json()["detail"]
    assert o.patch(f"/projects/{project.id}", json={"name": "Renamed"}).json()["code"] == "licence_expired"
    # exports still work: people can take their work with them
    assert o.post(f"/projects/{project.id}/exports", json={"format": "geojson"}).json().get("code") != "licence_expired"
    # an API key with write access is read-only too
    ends(o.org_id, 30)
    key = o.post("/org/api-keys", json={"name": "Loader", "access": "write"}).json()["key"]
    ends(o.org_id, -15)
    assert client.post("/projects", headers={"Authorization": f"Bearer {key}"}, json={"name": "x"}).json()["code"] == "licence_expired"
    # renewing lifts it at once
    ends(o.org_id, 365)
    assert o.post("/projects", json={"name": "Back to work"}).status_code == 201


def test_suspended_organizations_are_closed(client, project):
    o = project.owner
    ends(o.org_id, 100, suspended=True)
    assert o.get("/me").json()["org"]["licence"]["status"] == "suspended"
    r = o.get("/projects")
    assert r.status_code == 403 and r.json()["code"] == "licence_suspended" and "GeoEstate" in r.json()["detail"]
    assert o.get("/org").status_code == 200                       # they can still see why
    ends(o.org_id, 100)
    assert o.get("/projects").status_code == 200
    # the free Individual plan has no licence to end
    solo = Actor(client, "Solo", plan=None)
    assert solo.get("/me").json()["org"]["licence"] is None and solo.post("/projects", json={"name": "Mine"}).status_code == 201


def test_public_forms_close_when_the_licence_ends(client, project):
    o = project.owner
    token = o.patch(f"/forms/{project.form_id}/sharing", json={"share_mode": "public"}).json()["share_token"]
    assert client.get(f"/public/forms/{token}").status_code == 200
    ends(o.org_id, -15)
    r = client.get(f"/public/forms/{token}")
    assert r.status_code == 403 and "closed" in r.json()["detail"]
    sub = client.post(f"/public/forms/{token}/submissions", json={"id": __import__("uuid").uuid4().hex, "geometry": pt(),
                                                                  "properties": {"type": "Clinic"}})
    assert sub.status_code == 403
    ends(o.org_id, 100, suspended=True)
    assert client.get(f"/public/forms/{token}").status_code == 404


def test_the_read_only_day_is_emailed(client, project, outbox, monkeypatch):
    from app import reminders
    o = project.owner
    monkeypatch.setattr(settings, "platform_admins", "boss@geoestate.example")
    base = date.today() + timedelta(days=4000)          # far ahead, so other tests' organizations are not due
    end = base + timedelta(days=7)
    ends(o.org_id, 4007)

    async def go(day):
        from app.db import pool
        async with pool.connection() as conn:
            return await reminders.run(conn, day)

    def run(day):                                        # on the app's own event loop, where the pool lives
        return client.portal.call(go, day)
    assert run(base) == 1
    mail = next(m for m in outbox if m["to"] == o.email)
    assert "14 more days" in mail["body"] and "read-only" in mail["body"]
    assert run(end + timedelta(days=14)) == 1
    ro = [m for m in outbox if m["to"] == o.email][-1]
    assert "now read-only" in ro["subject"] and "export" in ro["body"]
    assert any(m["to"] == "boss@geoestate.example" and m["subject"].startswith("Read-only:") for m in outbox)
    assert run(end + timedelta(days=14)) == 0                     # once only


def test_support_visits(client, project, outbox, monkeypatch):
    boss = Actor(client, "Super", plan=None)
    monkeypatch.setattr(settings, "platform_admins", boss.email)
    helper = Actor(client, "Helper", plan=None)
    boss.post("/admin/staff", json={"email": helper.email, "role": "support"})
    finance = Actor(client, "Counter", plan=None)
    boss.post("/admin/staff", json={"email": finance.email, "role": "finance"})
    o, pid = project.owner, project.id

    assert helper.get(f"/projects/{pid}").status_code == 404
    assert finance.post(f"/admin/orgs/{o.org_id}/support", json={"reason": "Looking around"}).status_code == 403
    v = helper.post(f"/admin/orgs/{o.org_id}/support", json={"reason": "Ada asked why her map is empty", "hours": 1})
    assert v.status_code == 201 and v.json()["active"]
    mail = next(m for m in outbox if m["to"] == o.email)
    assert "cannot change anything" in mail["body"] and "why her map is empty" in mail["body"]

    p = helper.get(f"/projects/{pid}").json()
    assert p["role"] == "viewer" and p["support_view"] is True
    assert pid in [x["id"] for x in helper.get("/projects").json()["items"]]
    assert helper.get(f"/projects/{pid}/features").status_code == 200
    assert helper.patch(f"/projects/{pid}", json={"name": "Nope"}).status_code == 403          # read-only
    # the customer sees it, and so does the customer page in the console
    seen = o.get("/org/support-visits").json()
    assert seen[0]["staff_name"] == "Helper" and seen[0]["reason"] == "Ada asked why her map is empty" and seen[0]["active"]
    d = boss.get(f"/admin/orgs/{o.org_id}").json()
    assert d["support_visits"][0]["active"] and [x["id"] for x in d["projects"]] == [pid]

    assert helper.post(f"/admin/support/{v.json()['id']}/end").json()["active"] is False
    assert helper.get(f"/projects/{pid}").status_code == 404
    # a visit that runs out closes by itself
    v2 = helper.post(f"/admin/orgs/{o.org_id}/support", json={"reason": "Second look"}).json()
    with psycopg.connect(settings.database_url, autocommit=True) as c:
        c.execute("UPDATE support_sessions SET ends_at = now() - interval '1 minute' WHERE id = %s", (v2["id"],))
    assert helper.get(f"/projects/{pid}").status_code == 404
    acts = [a["action"] for a in boss.get("/admin/activity", params={"org_id": o.org_id}).json()]
    assert "platform.support_start" in acts and "platform.support_end" in acts
