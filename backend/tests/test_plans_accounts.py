import re
import uuid

import pytest

from conftest import Actor, set_plan, uid


@pytest.fixture
def outbox(monkeypatch):
    """Every email the app sends, as (to, subject, body, action)."""
    sent = []

    async def fake(to, subject, body, *, action=None, key=None, raise_errors=False):
        sent.append({"to": to, "subject": subject, "body": body, "action": action})
        return True
    from app.routers import auth, org
    monkeypatch.setattr(org, "send_email", fake)
    monkeypatch.setattr(auth, "send_email", fake)
    return sent


def _token(mail) -> str:
    return re.search(r"token=([\w-]+)", mail["action"][1]).group(1)


def test_individual_plan_holds_one_person_plus_collectors_and_viewers(client, outbox):
    me = Actor(client, "Student", plan=None)
    o = me.get("/org").json()
    assert o["plan"] == "individual" and o["plan_name"] == "Individual" and o["caps"] == {"seats": 1, "collectors": 5, "viewers": 5}
    for i in range(5):
        assert me.post("/org/accounts", json={"name": f"C{i}", "email": f"{uid()}@example.com", "role": "collector"}).status_code == 201
    over = me.post("/org/accounts", json={"name": "C6", "email": f"{uid()}@example.com", "role": "collector"})
    assert over.status_code == 402 and "5 field collectors" in over.json()["detail"]
    seat = me.post("/org/accounts", json={"name": "Colleague", "email": f"{uid()}@example.com", "role": "member"})
    assert seat.status_code == 402 and "1 team seats" in seat.json()["detail"]
    assert me.post("/org/accounts", json={"name": "V", "email": f"{uid()}@example.com", "role": "viewer"}).status_code == 201
    u = me.get("/org").json()["usage"]
    assert (u["seats"], u["collectors"], u["viewers"]) == (1, 5, 1)


def test_admin_creates_an_account_and_the_person_sets_their_password(client, outbox, project):
    o = project.owner
    email = f"{uid()}@example.com"
    r = o.post("/org/accounts", json={"name": "Bola Ade", "email": email, "role": "collector",
                                      "projects": [{"project_id": project.id}]})
    assert r.status_code == 201, r.text
    assert r.json()["email_sent"] and r.json()["temporary_password"] is None and r.json()["member"]["role"] == "collector"
    mail = outbox[-1]
    assert mail["to"] == email and "Set your password" == mail["action"][0] and "a field collector" in mail["body"]
    # nobody can sign in before the password is set
    assert client.post("/auth/login", json={"email": email, "password": "anything-at-all"}).status_code == 401
    tok = _token(mail)
    info = client.get(f"/auth/password-link/{tok}").json()
    assert info == {"email": email, "name": "Bola Ade", "purpose": "set", "org_name": o.get("/org").json()["name"]}
    s = client.post("/auth/set-password", json={"token": tok, "password": "a-good-new-password"})
    assert s.status_code == 200 and s.json()["user"]["org"]["role"] == "collector" and s.json()["user"]["must_change_password"] is False
    assert client.post("/auth/set-password", json={"token": tok, "password": "another-password"}).status_code == 410   # once only
    assert client.post("/auth/login", json={"email": email, "password": "a-good-new-password"}).status_code == 200
    # they were added to the project as a collector, and cannot be made its admin or create projects of their own
    members = {m["email"]: m["role"] for m in o.get(f"/projects/{project.id}/members").json()["items"]}
    assert members[email] == "collector"
    h = {"Authorization": f"Bearer {s.json()['access_token']}"}
    uid_ = s.json()["user"]["id"]
    assert o.patch(f"/projects/{project.id}/members/{uid_}", json={"role": "admin"}).status_code == 422
    assert client.post("/projects", json={"name": "Mine"}, headers=h).status_code == 403


def test_temporary_password_must_be_changed_at_first_sign_in(client, outbox, project):
    o = project.owner
    email = f"{uid()}@example.com"
    r = o.post("/org/accounts", json={"name": "Field Hand", "email": email, "role": "collector", "delivery": "temporary"}).json()
    tmp = r["temporary_password"]
    assert re.fullmatch(r"[A-Za-z2-9]{4}-[A-Za-z2-9]{4}-[A-Za-z2-9]{4}", tmp) and r["email_sent"] is False
    assert not [m for m in outbox if m["to"] == email]                 # a password is never emailed
    login = client.post("/auth/login", json={"email": email, "password": tmp}).json()
    assert login["user"]["must_change_password"] is True
    h = {"Authorization": f"Bearer {login['access_token']}"}
    assert client.get("/me", headers=h).json()["must_change_password"] is True
    assert client.post("/auth/change-password", json={"current_password": "wrong-one", "new_password": "x" * 10}, headers=h).status_code == 422
    assert client.post("/auth/change-password", json={"current_password": tmp, "new_password": "my-own-password"}, headers=h).status_code == 204
    assert client.get("/me", headers=h).json()["must_change_password"] is False


def test_forgot_password_and_resend(client, outbox, project):
    o = project.owner
    assert client.post("/auth/forgot-password", json={"email": f"{uid()}@example.com"}).status_code == 202   # unknown: same answer
    assert not outbox
    assert client.post("/auth/forgot-password", json={"email": o.email}).status_code == 202
    tok = _token(outbox[-1])
    assert client.get(f"/auth/password-link/{tok}").json()["purpose"] == "reset"
    old_refresh = o.tokens["refresh_token"]
    assert client.post("/auth/set-password", json={"token": tok, "password": "brand-new-password"}).status_code == 200
    assert client.post("/auth/refresh", json={"refresh_token": old_refresh}).status_code == 401      # other sessions end
    # an admin can send a fresh link; the older one stops working
    email = f"{uid()}@example.com"
    who = o.post("/org/accounts", json={"name": "Late Reader", "email": email, "role": "viewer"}).json()["member"]["user_id"]
    first = _token(outbox[-1])
    assert o.post(f"/org/members/{who}/send-link").status_code == 202
    second = _token(outbox[-1])
    assert first != second and client.get(f"/auth/password-link/{first}").status_code == 410
    assert client.get(f"/auth/password-link/{second}").status_code == 200


def test_people_are_counted_by_kind_and_roles_follow(client, outbox, project, actor):
    o = project.owner
    set_plan(o.org_id, "standard", seats=2, collectors=1, viewers=1)
    caps = o.get("/org").json()["caps"]
    assert caps == {"seats": 2, "collectors": 1, "viewers": 1}
    m = o.post("/org/accounts", json={"name": "Member", "email": f"{uid()}@example.com", "role": "member",
                                      "projects": [{"project_id": project.id}]}).json()["member"]
    assert o.post("/org/accounts", json={"name": "Another", "email": f"{uid()}@example.com", "role": "admin"}).status_code == 402
    assert o.post("/org/accounts", json={"name": "C", "email": f"{uid()}@example.com", "role": "collector"}).status_code == 201
    # moving someone to a full kind is refused; to a free one works and their project role follows
    assert o.patch(f"/org/members/{m['user_id']}", json={"role": "collector"}).status_code == 402
    assert o.patch(f"/org/members/{m['user_id']}", json={"role": "viewer"}).status_code == 200
    roles = {x["user_id"]: x["role"] for x in o.get(f"/projects/{project.id}/members").json()["items"]}
    assert roles[m["user_id"]] == "viewer"
    # viewers cannot join a map to edit it; field collectors join as contributors
    mp = o.post("/maps", json={"name": "Campaign"}).json()
    code = o.patch(f"/maps/{mp['id']}", json={"join_open": True}).json()["join_code"]
    assert code
    viewer = Actor(client, "Viewer", plan=None)
    set_plan(o.org_id, "standard", seats=2, collectors=1, viewers=2)
    assert o.post("/org/accounts", json={"name": "x", "email": viewer.email, "role": "viewer"}).status_code == 201
    assert viewer.post(f"/join/{code}").status_code == 403


def test_existing_accounts_and_other_organizations(client, outbox, project):
    o = project.owner
    fresh = Actor(client, "Fresh", plan=None)                       # signed up alone, nothing made yet
    r = o.post("/org/accounts", json={"name": "ignored", "email": fresh.email, "role": "member"})
    assert r.status_code == 201 and r.json()["email_sent"] and outbox[-1]["subject"].startswith("You joined")
    assert fresh.get("/me").json()["org"]["id"] == o.org_id
    busy = Actor(client, "Busy", plan=None)
    busy.post("/projects", json={"name": "Theirs"})
    assert o.post("/org/accounts", json={"name": "x", "email": busy.email, "role": "member"}).status_code == 409
    assert o.post("/org/accounts", json={"name": "x", "email": fresh.email, "role": "member"}).status_code == 409
    other = Actor(client, "Other")
    pid = other.post("/projects", json={"name": "Not yours"}).json()["id"]
    bad = o.post("/org/accounts", json={"name": "x", "email": f"{uid()}@example.com", "projects": [{"project_id": pid}]})
    assert bad.status_code == 422


def test_only_owners_add_admins_and_members_cannot_add_anyone(client, outbox, project):
    o = project.owner
    adm = o.post("/org/accounts", json={"name": "Admin", "email": f"{uid()}@example.com", "role": "admin", "delivery": "temporary"}).json()
    login = client.post("/auth/login", json={"email": adm["member"]["email"], "password": adm["temporary_password"]}).json()
    h = {"Authorization": f"Bearer {login['access_token']}"}
    assert client.post("/org/accounts", json={"name": "A2", "email": f"{uid()}@example.com", "role": "admin"}, headers=h).status_code == 403
    assert client.post("/org/accounts", json={"name": "M", "email": f"{uid()}@example.com", "role": "member"}, headers=h).status_code == 201
    mem = o.post("/org/accounts", json={"name": "Mem", "email": f"{uid()}@example.com", "role": "member", "delivery": "temporary"}).json()
    ml = client.post("/auth/login", json={"email": mem["member"]["email"], "password": mem["temporary_password"]}).json()
    assert client.post("/org/accounts", json={"name": "Z", "email": f"{uid()}@example.com"},
                       headers={"Authorization": f"Bearer {ml['access_token']}"}).status_code == 403
