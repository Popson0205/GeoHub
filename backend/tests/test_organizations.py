import uuid

import pytest

from app.config import settings
from conftest import Actor, pt, uid


def _set_limits(org_id, **limits):
    import json
    import psycopg
    with psycopg.connect(settings.database_url, autocommit=True) as c:
        c.execute("UPDATE organizations SET limits = %s WHERE id = %s", (json.dumps(limits), org_id))


def test_sign_up_creates_an_organization_the_person_owns(client):
    a = Actor.__new__(Actor)
    r = client.post("/auth/register", json={"email": f"{uid()}@example.com", "password": "correct-horse-battery",
                                            "name": "Ada", "organization": "Acme Surveys"})
    assert r.status_code == 201, r.text
    org = r.json()["user"]["org"]
    assert org["name"] == "Acme Surveys" and org["role"] == "owner" and org["slug"].startswith("acme-surveys")
    h = {"Authorization": f"Bearer {r.json()['access_token']}"}
    me = client.get("/me", headers=h).json()
    assert me["org"]["id"] == org["id"]
    o = client.get("/org", headers=h).json()
    assert o["usage"] == {"seats": 1, "collectors": 0, "viewers": 0, "projects": 0, "records": 0}
    assert o["limits"] == {} and o["single_org"] is False and o["plan"] == "individual"
    assert o["caps"] == {"seats": 1, "collectors": 5, "viewers": 5}


def test_invitations_people_and_roles(actor, client):
    owner = actor("Owner")
    email = f"{uid()}@example.com"
    inv = owner.post("/org/members", json={"email": email, "role": "member"})
    assert inv.status_code == 201 and inv.json()["status"] == "invited"
    assert owner.get("/org").json()["usage"]["seats"] == 2                  # an invitation holds a seat
    # signing up with the invited email joins the organization instead of creating one
    r = client.post("/auth/register", json={"email": email, "password": "correct-horse-battery", "name": "Bola",
                                            "organization": "ignored"})
    assert r.json()["user"]["org"]["id"] == owner.get("/org").json()["id"] and r.json()["user"]["org"]["role"] == "member"
    members = owner.get("/org/members").json()
    assert [m["status"] for m in members] == ["active", "active"] and owner.get("/org").json()["usage"]["seats"] == 2
    bola = next(m for m in members if m["email"] == email)
    # roles: only owners change them, and the last owner cannot step down
    assert owner.patch(f"/org/members/{bola['user_id']}", json={"role": "admin"}).json()["role"] == "admin"
    assert owner.patch(f"/org/members/{owner.id}", json={"role": "member"}).status_code == 409
    # a member cannot invite; an admin can, but not administrators
    stranger_org_member = actor("Cyril")
    assert stranger_org_member.post("/org/members", json={"email": "someone@example.com"}).status_code == 201   # owner of their own org
    h = {"Authorization": f"Bearer {r.json()['access_token']}"}
    assert client.post("/org/members", json={"email": f"{uid()}@example.com", "role": "admin"}, headers=h).status_code == 403
    assert client.post("/org/members", json={"email": f"{uid()}@example.com"}, headers=h).status_code == 201


def test_projects_are_shared_within_an_organization(actor, project):
    o = project.owner
    fresh = actor("Fresh sign-up")                                  # has an empty organization of their own
    r = o.post(f"/projects/{project.id}/members", json={"email": fresh.email, "role": "collector"})
    assert r.status_code == 201
    assert fresh.get("/me").json()["org"]["id"] == o.get("/org").json()["id"]   # brought into the organization
    # someone whose organization has work of its own cannot be pulled in
    busy = actor("Busy")
    busy.post("/projects", json={"name": "Their own"})
    r = o.post(f"/projects/{project.id}/members", json={"email": busy.email, "role": "viewer"})
    assert r.status_code == 409 and r.json()["code"] == "other_organization"
    assert busy.get(f"/projects/{project.id}").status_code == 404


def test_organization_admins_and_owners_run_every_project(actor, project, client):
    o = project.owner
    admin = actor("Org admin")
    assert o.post("/org/members", json={"email": admin.email, "role": "admin"}).status_code == 201
    # not a member of the project, yet sees it and can manage it
    listed = {p["id"]: p["role"] for p in admin.get("/projects").json()["items"]}
    assert listed.get(project.id) == "admin"
    assert admin.get(f"/projects/{project.id}/audit").status_code == 200
    assert admin.post(f"/projects/{project.id}/members", json={"email": f"{uid()}@example.com", "role": "collector"}).status_code == 201
    assert admin.get(f"/projects/{project.id}/bundle").status_code == 200
    # a plain organization member does not see projects they were not added to
    member = actor("Member")
    o.post("/org/members", json={"email": member.email})
    assert project.id not in {p["id"] for p in member.get("/projects").json()["items"]}
    # removing someone takes them off the organization's projects and hands over their maps
    m = admin.post("/maps", json={"name": "Admin's map"}).json()
    assert o.delete(f"/org/members/{admin.id}").status_code == 204
    assert admin.get(f"/projects/{project.id}").status_code == 404
    assert o.get(f"/maps/{m['id']}").json()["role"] == "owner"
    assert admin.get("/me").json()["org"]["id"] != o.get("/org").json()["id"]   # a fresh organization of their own


def test_plan_limits(actor, project):
    o = project.owner
    org_id = o.get("/org").json()["id"]
    _set_limits(org_id, projects=1, seats=2, records=1)
    lim = o.post("/projects", json={"name": "Second"})
    assert lim.status_code == 402 and lim.json()["code"] == "plan_limit"
    assert o.post("/org/members", json={"email": f"{uid()}@example.com"}).status_code == 201       # seat 2 of 2
    assert o.post("/org/members", json={"email": f"{uid()}@example.com"}).status_code == 402
    assert o.get("/org").json()["limits"] == {"projects": 1, "seats": 2, "records": 1}
    first = o.post(f"/projects/{project.id}/features", json={"id": str(uuid.uuid4()), "form_id": project.form_id,
                                                              "geometry": pt(), "properties": {"type": "Clinic"}})
    assert first.status_code == 201
    over = o.post(f"/projects/{project.id}/features", json={"id": str(uuid.uuid4()), "form_id": project.form_id,
                                                             "geometry": pt(), "properties": {"type": "Clinic"}})
    assert over.status_code == 402 and over.json()["code"] == "plan_limit"
    # a phone syncing gets a clear rejection for that record, not a failed batch
    res = o.post("/sync/push", json={"project_id": project.id, "changes": [{
        "change_id": str(uuid.uuid4()), "id": str(uuid.uuid4()), "op": "create", "base_version": 0, "form_id": project.form_id,
        "geometry": pt(), "properties": {"type": "Clinic"}}]}).json()["results"][0]
    assert res["status"] == "rejected" and res["code"] == "PLAN_LIMIT"


def test_leaving(actor):
    owner = actor("Owner")
    assert owner.post("/org/leave").status_code == 409                  # alone: nothing to leave
    other = actor("Other")
    owner.post("/org/members", json={"email": other.email})
    assert owner.post("/org/leave").status_code == 409                  # the only owner
    org_id = owner.get("/org").json()["id"]
    assert other.post("/org/leave").status_code == 204
    assert other.get("/me").json()["org"]["id"] != org_id


def test_private_copy_is_invitation_only(client, monkeypatch):
    import psycopg
    monkeypatch.setattr(settings, "single_org", True)
    with psycopg.connect(settings.database_url, autocommit=True) as c:
        has_orgs = c.execute("SELECT 1 FROM organizations LIMIT 1").fetchone()
    assert has_orgs                                                     # other tests made some
    r = client.post("/auth/register", json={"email": f"{uid()}@example.com", "password": "correct-horse-battery", "name": "Walk-in"})
    assert r.status_code == 403 and r.json()["code"] == "invite_only"
    monkeypatch.setattr(settings, "single_org", False)
    host = Actor(client, "Host")
    email = f"{uid()}@example.com"
    host.post("/org/members", json={"email": email})
    monkeypatch.setattr(settings, "single_org", True)
    r = client.post("/auth/register", json={"email": email, "password": "correct-horse-battery", "name": "Invited"})
    assert r.status_code == 201 and r.json()["user"]["org"]["id"] == host.get("/org").json()["id"]
    assert host.get("/org").json()["single_org"] is True
