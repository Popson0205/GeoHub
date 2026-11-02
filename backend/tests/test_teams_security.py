import io
import re
import time

import psycopg
import pytest

from app.config import settings
from conftest import Actor, set_plan, uid


@pytest.fixture
def outbox(monkeypatch):
    sent = []

    async def fake(to, subject, body, *, action=None, key=None, raise_errors=False, brand=None):
        sent.append({"to": to, "subject": subject, "body": body, "action": action})
        return True
    from app import signup
    from app.routers import admin, auth, org
    for m in (signup, admin, auth, org):
        monkeypatch.setattr(m, "send_email", fake)
    return sent


def add(boss, role="member", name="Someone"):
    """A person made by an admin with a temporary password, signed in (password changed)."""
    email = f"{uid()}@example.com"
    r = boss.post("/org/accounts", json={"name": name, "email": email, "role": role, "delivery": "temporary"})
    assert r.status_code == 201, r.text
    tokens = boss.c.post("/auth/login", json={"email": email, "password": r.json()["temporary_password"]}).json()

    class P:
        pass
    p = P()
    p.id, p.email, p.password = r.json()["member"]["id"], email, r.json()["temporary_password"]
    p.h = {"Authorization": f"Bearer {tokens['access_token']}"}
    p.get = lambda url, **kw: boss.c.get(url, headers=p.h, **kw)
    p.post = lambda url, **kw: boss.c.post(url, headers=p.h, **kw)
    p.put = lambda url, **kw: boss.c.put(url, headers=p.h, **kw)
    p.patch = lambda url, **kw: boss.c.patch(url, headers=p.h, **kw)
    p.delete = lambda url, **kw: boss.c.delete(url, headers=p.h, **kw)
    return p


def project_ids(person):
    return {p["id"]: p["role"] for p in person.get("/projects").json()["items"]}


# ---------- teams ----------
def test_teams_come_with_organization_plans(client):
    solo = Actor(client, "Solo", plan=None)
    assert solo.post("/org/teams", json={"name": "North"}).status_code == 402
    boss = Actor(client, "Boss", plan="standard")
    assert boss.get("/org").json()["caps"]["teams"] == 2
    assert boss.post("/org/teams", json={"name": "North"}).status_code == 201
    assert boss.post("/org/teams", json={"name": "north"}).status_code == 409
    assert boss.post("/org/teams", json={"name": "South"}).status_code == 201
    third = boss.post("/org/teams", json={"name": "East"})
    assert third.status_code == 402 and "Delete a team" in third.json()["detail"]
    assert boss.get("/org").json()["usage"]["teams"] == 2
    set_plan(boss.org_id, "advanced")
    assert boss.post("/org/teams", json={"name": "East"}).status_code == 201


def test_a_team_gets_its_projects_and_a_lead_runs_them(client, outbox):
    boss = Actor(client, "Boss", plan="advanced")
    pid = boss.post("/projects", json={"name": "Ikeja survey"}).json()["id"]
    team = boss.post("/org/teams", json={"name": "North", "description": "Ikeja and Agege"}).json()
    lead, member, collector, viewer = add(boss, "member", "Lead"), add(boss, "member", "Mem"), add(boss, "collector", "Col"), add(boss, "viewer", "View")
    # leads must hold a team seat
    assert boss.put(f"/org/teams/{team['id']}/members/{collector.id}", json={"lead": True}).status_code == 422
    t = boss.put(f"/org/teams/{team['id']}/members/{lead.id}", json={"lead": True}).json()
    assert t["members"][0]["lead"] and not t["you_lead"] and t["can_edit"]
    # a lead adds people, but does not choose leads; others cannot change the team
    assert lead.put(f"/org/teams/{team['id']}/members/{member.id}", json={}).status_code == 200
    assert lead.put(f"/org/teams/{team['id']}/members/{collector.id}", json={}).status_code == 200
    assert lead.put(f"/org/teams/{team['id']}/members/{viewer.id}", json={}).status_code == 200
    assert lead.put(f"/org/teams/{team['id']}/members/{member.id}", json={"lead": True}).status_code == 403
    assert member.put(f"/org/teams/{team['id']}/members/{member.id}", json={}).status_code == 403
    mine = next(x for x in lead.get("/org/teams").json() if x["id"] == team["id"])
    assert mine["you_lead"] and mine["can_manage_people"] and not mine["can_edit"] and len(mine["members"]) == 4

    assert pid not in project_ids(member)
    # the project is given to the team as admins: kept to what each kind of place allows; the lead runs it
    assert boss.put(f"/projects/{pid}/teams/{team['id']}", json={"role": "admin"}).status_code == 200
    assert project_ids(lead)[pid] == "admin" and project_ids(member)[pid] == "admin"
    assert project_ids(collector)[pid] == "collector" and project_ids(viewer)[pid] == "viewer"
    boss.put(f"/projects/{pid}/teams/{team['id']}", json={"role": "viewer"})
    assert project_ids(lead)[pid] == "admin" and project_ids(member)[pid] == "viewer" and project_ids(collector)[pid] == "viewer"
    assert lead.get(f"/projects/{pid}/teams").json()[0]["member_count"] == 4
    # an admin through the team can do admin things: add another team
    other = boss.post("/org/teams", json={"name": "South"}).json()
    assert lead.put(f"/projects/{pid}/teams/{other['id']}", json={"role": "collector"}).status_code == 200
    assert member.put(f"/projects/{pid}/teams/{other['id']}", json={"role": "collector"}).status_code == 403
    # a team from another organization cannot be given the project
    rival = Actor(client, "Rival", plan="advanced")
    foreign = rival.post("/org/teams", json={"name": "Theirs"}).json()
    assert boss.put(f"/projects/{pid}/teams/{foreign['id']}", json={"role": "viewer"}).status_code == 404

    # out of the team: out of its projects; a demoted lead stops leading
    assert lead.delete(f"/org/teams/{team['id']}/members/{member.id}").status_code == 200
    assert pid not in project_ids(member)
    boss.patch(f"/org/members/{lead.id}", json={"role": "collector"})
    t = next(x for x in boss.get("/org/teams").json() if x["id"] == team["id"])
    assert not any(x["lead"] for x in t["members"])
    # removed from the organization: out of its teams
    boss.delete(f"/org/members/{collector.id}")
    t = next(x for x in boss.get("/org/teams").json() if x["id"] == team["id"])
    assert collector.id not in [x["user_id"] for x in t["members"]]
    # the team taken off the project, then deleted
    assert boss.delete(f"/projects/{pid}/teams/{team['id']}").status_code == 200
    assert pid not in project_ids(viewer)
    assert boss.delete(f"/org/teams/{team['id']}").status_code == 204
    assert [x["name"] for x in boss.get("/org/teams").json()] == ["South"]


# ---------- many people from a spreadsheet ----------
def _csv(rows):
    return ("email,name,role,team,projects\n" + "\n".join(",".join(r) for r in rows)).encode()


def _upload(boss, data, name="people.csv", **form):
    return boss.post("/org/accounts/import", files={"file": (name, data)}, data={k: str(v).lower() if isinstance(v, bool) else v for k, v in form.items()})


def test_import_previews_each_row_then_adds_everyone(client, outbox):
    boss = Actor(client, "Boss", plan="advanced")
    boss.post("/projects", json={"name": "Ikeja survey"})
    boss.post("/org/teams", json={"name": "North"})
    already = add(boss, "member")
    rival = Actor(client, "Busy", plan="advanced")
    rival.post("/projects", json={"name": "Their work"})
    d = uid()
    rows = [[f"a{d}@example.com", "Ada Obi", "field collector", "North", "Ikeja survey"],
            [f"b{d}@example.com", "Bola Ade", "", "", ""],
            ["not-an-email", "Who", "", "", ""],
            [f"a{d}@example.com", "Ada Again", "", "", ""],
            [f"c{d}@example.com", "Chi", "boss", "Nowhere", "Missing project"],
            [already.email, "Already", "", "", ""],
            [rival.email, "Elsewhere", "", "", ""]]
    p = _upload(boss, _csv(rows), preview=True)
    assert p.status_code == 200, p.text
    out = p.json()
    assert not out["ok"] and not out["done"]
    by = {r["row"]: r for r in out["rows"]}
    assert by[2]["status"] == "new" and by[2]["role"] == "collector" and by[2]["projects"] == ["Ikeja survey"]
    assert by[3]["status"] == "new" and by[3]["role"] == "collector"           # the default role
    assert "Not an email" in by[4]["error"]
    assert "twice" in by[5]["error"]
    assert "Unknown role" in by[6]["error"] and "No team" in by[6]["error"] and "No project" in by[6]["error"]
    assert "Already in your organization" in by[7]["error"]
    assert "another organization" in by[8]["error"]
    assert out["capacity"] == [{"kind": "collectors", "needed": 2, "left": 300 - 0}]
    assert _upload(boss, _csv(rows), preview=False).status_code == 422
    assert len(boss.get("/org/members").json()) == 2                         # nothing was added

    sent = len(outbox)
    good = _upload(boss, _csv(rows[:2] + [[f"v{d}@example.com", "Vi", "viewer", "", ""]]), preview=False, default_role="member")
    assert good.status_code == 200, good.text
    g = good.json()
    assert g["done"] and g["emails_queued"] == 3 and [r["status"] for r in g["rows"]] == ["created", "created", "created"]
    assert g["rows"][1]["role"] == "member"
    assert len(outbox) == sent + 3 and all("set-password?token=" in m["action"][1] for m in outbox[-3:])
    people = {m["email"]: m["role"] for m in boss.get("/org/members").json()}
    assert people[f"a{d}@example.com"] == "collector" and people[f"b{d}@example.com"] == "member" and people[f"v{d}@example.com"] == "viewer"
    team = boss.get("/org/teams").json()[0]
    assert [x["email"] for x in team["members"]] == [f"a{d}@example.com"]
    proj = boss.get("/projects").json()["items"][0]
    members = boss.get(f"/projects/{proj['id']}/members").json()["items"]
    assert any(x["email"] == f"a{d}@example.com" and x["role"] == "collector" for x in members)


def test_import_reads_excel_and_respects_the_plan(client, outbox):
    from openpyxl import Workbook
    boss = Actor(client, "Boss", plan="standard")
    set_plan(boss.org_id, "standard", viewers=1)
    wb = Workbook()
    ws = wb.active
    ws.append(["Email", "Full name", "Role"])
    d = uid()
    ws.append([f"x{d}@example.com", "Xavier", "Viewer"])
    ws.append([f"y{d}@example.com", "Yemi", "viewer"])
    buf = io.BytesIO()
    wb.save(buf)
    p = _upload(boss, buf.getvalue(), name="people.xlsx", preview=True).json()
    assert [r["status"] for r in p["rows"]] == ["new", "new"]
    assert p["capacity"] == [{"kind": "viewers", "needed": 2, "left": 1}] and not p["ok"]
    assert _upload(boss, buf.getvalue(), name="people.xlsx", preview=False).status_code == 422
    set_plan(boss.org_id, "standard")
    done = _upload(boss, buf.getvalue(), name="people.xlsx", preview=False, delivery="temporary").json()
    assert done["done"] and all(re.fullmatch(r"\w{4}-\w{4}-\w{4}", r["temporary_password"]) for r in done["rows"])
    assert client.post("/auth/login", json={"email": f"x{d}@example.com", "password": done["rows"][0]["temporary_password"]}).status_code == 200
    # bad files say what is wrong
    assert "email" in _upload(boss, b"who,what\n1,2\n").json()["detail"]
    assert _upload(boss, b"", name="empty.csv").status_code == 422
    assert "xlsx" in _upload(boss, b"\xd0\xcf\x11\xe0old", name="old.xls").json()["detail"]
    member = add(boss, "member")
    assert member.post("/org/accounts/import", files={"file": ("p.csv", _csv([]))}).status_code == 403


# ---------- two-step sign-in ----------
class Clock:
    def __init__(self):
        self.t = time.time()

    def time(self):
        return self.t

    def tick(self):
        self.t += 30


@pytest.fixture
def clock(monkeypatch):
    from app import mfa
    c = Clock()
    monkeypatch.setattr(mfa, "clock", c)
    return c


def turn_on(person, clock):
    from app import mfa
    s = person.post("/auth/mfa/setup").json()
    assert s["otpauth_url"].startswith("otpauth://totp/Geohub:") and s["secret"] in s["otpauth_url"]
    assert person.post("/auth/mfa/enable", json={"code": "000000" if mfa.code_now(s["secret"], clock.t) != "000000" else "111111"}).status_code == 422
    r = person.post("/auth/mfa/enable", json={"code": mfa.code_now(s["secret"], clock.t)})
    assert r.status_code == 200, r.text
    clock.tick()
    return s["secret"], r.json()["recovery_codes"]


def test_two_step_sign_in(client, clock):
    from app import mfa
    me = Actor(client, "Careful", plan="standard")
    assert me.get("/auth/mfa").json() == {"enabled": False, "enabled_at": None, "recovery_codes_left": 0, "required_by_org": False}
    secret, codes = turn_on(me, clock)
    assert len(codes) == 10 and me.get("/auth/mfa").json()["recovery_codes_left"] == 10
    assert me.post("/auth/mfa/setup").status_code == 409

    # the password alone no longer signs in
    first = client.post("/auth/login", json={"email": me.email, "password": me.password}).json()
    assert first["mfa_required"] and "access_token" not in first
    assert client.post("/auth/mfa/verify", json={"mfa_token": first["mfa_token"], "code": "123456"}).status_code == 401
    code = mfa.code_now(secret, clock.t)
    ok = client.post("/auth/mfa/verify", json={"mfa_token": first["mfa_token"], "code": code})
    assert ok.status_code == 200 and ok.json()["user"]["mfa_enabled"], ok.text
    again = client.post("/auth/login", json={"email": me.email, "password": me.password}).json()
    assert "already used" in client.post("/auth/mfa/verify", json={"mfa_token": again["mfa_token"], "code": code}).json()["detail"]
    # a recovery code works once
    assert client.post("/auth/mfa/verify", json={"mfa_token": again["mfa_token"], "code": codes[0].upper()}).status_code == 200
    assert client.post("/auth/mfa/verify", json={"mfa_token": again["mfa_token"], "code": codes[0]}).status_code == 401
    assert me.get("/auth/mfa").json()["recovery_codes_left"] == 9
    # the challenge is not an access token, and an access token is not a challenge
    assert client.get("/projects", headers={"Authorization": f"Bearer {again['mfa_token']}"}).status_code == 401
    assert client.post("/auth/mfa/verify", json={"mfa_token": me.tokens["access_token"], "code": codes[1]}).status_code == 401
    # the secret is not stored as it is
    with psycopg.connect(settings.database_url) as c:
        stored = c.execute("SELECT totp_secret FROM users WHERE id = %s", (me.id,)).fetchone()[0]
    assert stored.startswith("v1:") and secret not in stored
    # turning it off needs a code
    clock.tick()
    assert me.post("/auth/mfa/disable", json={"code": "999999"}).status_code == 401
    assert me.post("/auth/mfa/disable", json={"code": mfa.code_now(secret, clock.t)}).status_code == 204
    assert "access_token" in client.post("/auth/login", json={"email": me.email, "password": me.password}).json()


def test_an_organization_can_require_it(client, clock, outbox):
    from app import mfa
    boss = Actor(client, "Boss", plan="standard")
    member = add(boss, "member", "Mem Ber")
    assert boss.patch("/org/security", json={"require_mfa": True}).status_code == 409    # not on for the admin yet
    turn_on(boss, clock)
    assert member.patch("/org/security", json={"require_mfa": True}).status_code == 403
    r = boss.patch("/org/security", json={"require_mfa": True})
    assert r.status_code == 200 and r.json()["require_mfa"]

    # the member's session now only reaches /me and the setup
    blocked = member.get("/projects")
    assert blocked.status_code == 403 and blocked.json()["code"] == "mfa_setup_required"
    me = member.get("/me").json()
    assert me["mfa_setup_required"] and not me["mfa_enabled"]
    assert member.get("/auth/mfa").json()["required_by_org"]
    secret, _ = turn_on(member, clock)
    assert member.get("/projects").status_code == 200
    assert member.post("/auth/mfa/disable", json={"code": mfa.code_now(secret, clock.t)}).json()["code"] == "mfa_required"

    # a lost phone: an admin turns it off, and the person sets it up again
    assert member.delete(f"/org/members/{boss.id}/mfa").status_code == 403
    assert boss.delete(f"/org/members/{member.id}/mfa").status_code == 204
    assert outbox[-1]["to"] == member.email and "turned off" in outbox[-1]["subject"]
    login = client.post("/auth/login", json={"email": member.email, "password": member.password}).json()
    assert login["user"]["mfa_setup_required"]
    assert boss.delete(f"/org/members/{member.id}/mfa").status_code == 409
    solo = Actor(client, "Solo", plan=None)
    assert solo.patch("/org/security", json={"require_mfa": False}).status_code == 403


def test_sso_and_links_also_ask_for_the_code(client, clock, outbox):
    """A set-password link must not get round two-step sign-in."""
    me = Actor(client, "Linked", plan="standard")
    turn_on(me, clock)
    client.post("/auth/forgot-password", json={"email": me.email})
    token = re.search(r"token=([\w-]+)", outbox[-1]["action"][1]).group(1)
    r = client.post("/auth/set-password", json={"token": token, "password": "a-brand-new-one"}).json()
    assert r["mfa_required"] and "access_token" not in r


# ---------- API keys ----------
def test_api_keys(client, outbox):
    solo = Actor(client, "Solo", plan=None)
    assert solo.post("/org/api-keys", json={"name": "Script"}).status_code == 403
    boss = Actor(client, "Boss", plan="standard")
    pid = boss.post("/projects", json={"name": "Keyed"}).json()["id"]
    r = boss.post("/org/api-keys", json={"name": "Nightly export", "access": "read"})
    assert r.status_code == 201, r.text
    k = r.json()
    assert k["key"].startswith("ghk_") and k["prefix"] == k["key"][:12] and k["user_name"] == "Boss"
    key = {"Authorization": f"Bearer {k['key']}"}
    assert any(p["id"] == pid for p in client.get("/projects", headers=key).json()["items"])
    no = client.post("/projects", headers=key, json={"name": "Nope"})
    assert no.status_code == 403 and no.json()["code"] == "read_only_key"
    assert client.post("/org/api-keys", headers=key, json={"name": "Spawn"}).status_code == 403   # keys do not make keys
    assert client.post("/auth/change-password", headers=key, json={"current_password": "x", "new_password": "yyyyyyyy"}).status_code == 403
    listed = boss.get("/org/api-keys").json()
    assert listed[0]["last_used_at"] is not None and "key" not in listed[0]

    w = boss.post("/org/api-keys", json={"name": "Loader", "access": "write", "expires_in_days": 30}).json()
    assert w["expires_at"] is not None
    assert client.post("/projects", headers={"Authorization": f"Bearer {w['key']}"}, json={"name": "By script"}).status_code == 201

    # people see their own; administrators see and revoke everyone's
    member = add(boss, "member")
    mk = member.post("/org/api-keys", json={"name": "Mine", "access": "write"}).json()
    assert [x["name"] for x in member.get("/org/api-keys").json()] == ["Mine"]
    assert member.get("/org/api-keys?all=true").status_code == 403
    assert member.delete(f"/org/api-keys/{k['id']}").status_code == 403
    assert {x["name"] for x in boss.get("/org/api-keys?all=true").json()} == {"Nightly export", "Loader", "Mine"}
    assert boss.delete(f"/org/api-keys/{k['id']}").status_code == 204
    assert client.get("/projects", headers=key).status_code == 401
    assert next(x for x in boss.get("/org/api-keys").json() if x["id"] == k["id"])["revoked_at"] is not None
    # someone who leaves takes no working keys with them
    mkey = {"Authorization": f"Bearer {mk['key']}"}
    assert client.get("/projects", headers=mkey).status_code == 200
    boss.delete(f"/org/members/{member.id}")
    assert client.get("/projects", headers=mkey).status_code == 401
    assert client.get("/projects", headers={"Authorization": "Bearer ghk_made-up"}).status_code == 401
    viewer = add(boss, "viewer")
    assert viewer.post("/org/api-keys", json={"name": "W", "access": "write"}).status_code == 403


def test_codes_match_the_standard():
    """RFC 6238's test values (SHA-1, last 6 of the 8 digits), so any authenticator app agrees with us."""
    from app import mfa
    secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
    assert [mfa.code_now(secret, t) for t in (59, 1111111109, 1234567890, 2000000000)] == ["287082", "081804", "005924", "279037"]
    assert mfa.matching_step(secret, "287 082", at=59 + 30) == 1 and mfa.matching_step(secret, "287082", at=59 + 90) is None
    assert mfa.unseal(mfa.seal(secret)) == secret
