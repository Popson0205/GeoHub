import re
from datetime import date, timedelta

import psycopg
import pytest

from app.config import settings
from conftest import Actor, uid


@pytest.fixture
def outbox(monkeypatch):
    sent = []

    async def fake(to, subject, body, *, action=None, key=None, raise_errors=False, brand=None):
        sent.append({"to": to, "subject": subject, "body": body, "action": action})
        return True
    from app import reminders, signup
    from app.routers import admin, auth, org, security
    for m in (admin, auth, org, reminders, signup):
        monkeypatch.setattr(m, "send_email", fake)
    return sent


@pytest.fixture
def boss(client, monkeypatch):
    """The super admin from PLATFORM_ADMINS."""
    a = Actor(client, "Idris Super", plan=None)
    monkeypatch.setattr(settings, "platform_admins", a.email)
    return a


def sql(q, *params):
    with psycopg.connect(settings.database_url, autocommit=True) as c:
        c.execute(q, params)


def customer(boss, **kw):
    body = {"name": f"Client {uid()}", "plan": "standard", "owner_name": "Ada Obi", "owner_email": f"{uid()}@example.com",
            "subscription_starts": date.today().isoformat(), "subscription_ends": (date.today() + timedelta(days=364)).isoformat()} | kw
    r = boss.post("/admin/orgs", json=body)
    assert r.status_code == 201, r.text
    return r.json()


def staff_member(client, boss, role):
    a = Actor(client, f"Staff {role}", plan=None)
    assert boss.post("/admin/staff", json={"email": a.email, "role": role}).status_code == 201
    return a


def test_staff_roles(client, boss, outbox):
    me = boss.get("/admin/me").json()
    assert me["role"] == "super_admin" and "staff.manage" in me["perms"]
    assert boss.get("/me").json()["staff_role"] == "super_admin"
    support, finance, manager = staff_member(client, boss, "support"), staff_member(client, boss, "finance"), staff_member(client, boss, "account_manager")
    assert outbox[-1]["to"] == manager.email and "staff console" in outbox[-1]["subject"]
    assert support.get("/me").json()["staff_role"] == "support" and support.get("/me").json()["platform_admin"]
    o = customer(boss)

    # everyone on the staff sees customers; each role does only its own part
    for s in (support, finance, manager):
        assert s.get("/admin/orgs").status_code == 200 and s.get(f"/admin/orgs/{o['id']}").status_code == 200
    assert support.patch(f"/admin/orgs/{o['id']}", json={"plan": "advanced"}).status_code == 403
    assert support.post(f"/admin/orgs/{o['id']}/notes", json={"body": "Called the owner"}).status_code == 201
    assert finance.post(f"/admin/orgs/{o['id']}/notes", json={"body": "x"}).status_code == 403
    assert manager.patch(f"/admin/orgs/{o['id']}", json={"plan": "advanced"}).status_code == 200
    assert manager.post("/admin/staff", json={"email": f"{uid()}@example.com", "role": "support"}).status_code == 403
    assert Actor(client, "Customer").get("/admin/orgs").status_code == 404

    # someone new to Geohub gets an account and an email to set a password
    new = f"{uid()}@geoestate.example"
    listed = boss.post("/admin/staff", json={"email": new, "name": "New Hire", "role": "support"}).json()
    assert any(s["email"] == new and s["role"] == "support" for s in listed)
    assert "set-password?token=" in outbox[-1]["action"][1]
    # roles change, people leave; PLATFORM_ADMINS stays as it is, and nobody changes themselves
    staff_list = boss.get("/admin/staff").json()
    assert next(s for s in staff_list if s["email"] == boss.email.lower())["from_settings"]
    assert boss.patch(f"/admin/staff/{support.id}", json={"role": "finance"}).json()[0]["role"] == "super_admin"
    assert support.post(f"/admin/orgs/{o['id']}/notes", json={"body": "y"}).status_code == 403          # now finance
    assert boss.patch(f"/admin/staff/{boss.id}", json={"role": "support"}).status_code == 409
    assert boss.delete(f"/admin/staff/{boss.id}").status_code == 409
    assert boss.delete(f"/admin/staff/{support.id}").status_code == 200
    assert support.get("/admin/orgs").status_code == 404
    assert support.get("/me").json()["staff_role"] is None


def test_staff_need_two_step_sign_in(client, boss, monkeypatch):
    monkeypatch.setattr(settings, "staff_require_mfa", True)
    r = boss.get("/admin/orgs")
    assert r.status_code == 403 and r.json()["code"] == "staff_mfa_required"
    sql("UPDATE users SET totp_enabled_at = now() WHERE id = %s", boss.id)
    assert boss.get("/admin/orgs").status_code == 200


def test_licence_history_and_status(client, boss, outbox):
    o = customer(boss, invoice_ref="GE-2026-0001", note="First year")
    hist = boss.get(f"/admin/orgs/{o['id']}").json()["licences"]
    assert [(h["action"], h["invoice_ref"], h["note"], h["actor_name"]) for h in hist] == [("create", "GE-2026-0001", "First year", "Idris Super")]
    assert o["status"] == "active" and o["licence_kind"] == "paid"

    later = (date.today() + timedelta(days=729)).isoformat()
    boss.patch(f"/admin/orgs/{o['id']}", json={"subscription_ends": later, "invoice_ref": "GE-2027-0004"})
    boss.patch(f"/admin/orgs/{o['id']}", json={"plan": "advanced", "note": "More collectors"})
    boss.patch(f"/admin/orgs/{o['id']}", json={"name": "Renamed only"})                      # not a licence change
    hist = boss.get(f"/admin/orgs/{o['id']}").json()["licences"]
    assert [h["action"] for h in hist] == ["change", "renew", "create"]
    assert hist[0]["plan"] == "advanced" and hist[1]["ends"] == later and hist[1]["invoice_ref"] == "GE-2027-0004"

    # the end date passes: 14 days of grace, then expired
    sql("UPDATE organizations SET subscription_ends = current_date - 3 WHERE id = %s", o["id"])
    d = boss.get(f"/admin/orgs/{o['id']}").json()
    assert d["status"] == "grace" and d["grace_ends"] == (date.today() + timedelta(days=11)).isoformat()
    sql("UPDATE organizations SET subscription_ends = current_date - 20 WHERE id = %s", o["id"])
    assert o["id"] in [x["id"] for x in boss.get("/admin/orgs", params={"status": "expired"}).json()]
    assert o["id"] not in [x["id"] for x in boss.get("/admin/orgs", params={"status": "active"}).json()]

    # suspended, and back
    assert boss.post(f"/admin/orgs/{o['id']}/reactivate").status_code == 409
    s = boss.post(f"/admin/orgs/{o['id']}/suspend", json={"reason": "Invoice GE-2027-0004 unpaid"}).json()
    assert s["status"] == "suspended" and s["suspended_reason"] == "Invoice GE-2027-0004 unpaid"
    assert boss.post(f"/admin/orgs/{o['id']}/reactivate").json()["status"] == "expired"
    assert [h["action"] for h in boss.get(f"/admin/orgs/{o['id']}").json()["licences"]][:2] == ["reactivate", "suspend"]


def test_demo_licence(client, boss, outbox):
    r = client.post("/org-requests", json={"organization": "Ibadan Maps", "contact_name": "Tunde Ade", "email": f"{uid()}@example.com",
                                           "plan": "demo"})
    assert r.status_code == 202
    assert any(m["to"] == boss.email.lower() and m["subject"].startswith("Demo request") for m in outbox)
    assert "one-month demo" in outbox[-1]["body"]
    req = next(x for x in boss.get("/admin/requests").json() if x["organization"] == "Ibadan Maps")
    o = customer(boss, plan="standard", licence_kind="demo", subscription_starts=None, subscription_ends=None, request_id=req["id"])
    assert o["licence_kind"] == "demo" and o["status"] == "demo" and o["plan"] == "advanced"
    assert o["subscription_starts"] == date.today().isoformat() and o["subscription_ends"] == (date.today() + timedelta(days=29)).isoformat()
    assert "one-month demo" in outbox[-1]["body"]
    assert next(x for x in boss.get("/admin/requests").json() if x["id"] == req["id"])["status"] == "set_up"
    assert [h["action"] for h in boss.get(f"/admin/orgs/{o['id']}").json()["licences"]] == ["demo"]
    # the demo turns into a paid licence
    paid = boss.patch(f"/admin/orgs/{o['id']}", json={"licence_kind": "paid", "plan": "standard",
                                                      "subscription_ends": (date.today() + timedelta(days=365)).isoformat(),
                                                      "invoice_ref": "GE-2026-0009"}).json()
    assert paid["status"] == "active" and paid["licence_kind"] == "paid"
    assert o["id"] not in [x["id"] for x in boss.get("/admin/orgs", params={"status": "demo"}).json()]


def test_customer_page_and_support_actions(client, boss, outbox):
    o = customer(boss)
    owner_token = re.search(r"token=([\w-]+)", outbox[-1]["action"][1]).group(1)
    client.post("/auth/set-password", json={"token": owner_token, "password": "a-good-long-password"})
    owner_email = boss.get(f"/admin/orgs/{o['id']}").json()["owner_email"]
    login = client.post("/auth/login", json={"email": owner_email, "password": "a-good-long-password"}).json()
    h = {"Authorization": f"Bearer {login['access_token']}"}
    mate = client.post("/org/accounts", headers=h, json={"name": "Bola Ade", "email": f"{uid()}@example.com", "role": "member",
                                                         "delivery": "temporary"}).json()["member"]
    client.post("/org/teams", headers=h, json={"name": "North"})

    d = boss.get(f"/admin/orgs/{o['id']}").json()
    assert [(p["name"], p["role"]) for p in d["people"]] == [("Ada Obi", "owner"), ("Bola Ade", "member")]
    assert d["people"][0]["last_active"] is not None and d["people"][1]["last_active"] is None
    assert d["last_active"] is not None and d["teams"] == 1 and d["api_keys"] == 0
    assert any(a["action"] == "team.create" for a in d["activity"]) and any(a["action"] == "platform.org_create" for a in d["activity"])

    # notes: kept, and deleted by their author or a super admin
    n = boss.post(f"/admin/orgs/{o['id']}/notes", json={"body": "Wants 20 more collectors in January"}).json()
    assert boss.get(f"/admin/orgs/{o['id']}").json()["notes"][0]["body"] == "Wants 20 more collectors in January"
    assert boss.delete(f"/admin/notes/{n['id']}").status_code == 204

    # a set-password link, a lost phone, a new owner
    assert boss.post(f"/admin/orgs/{o['id']}/people/{mate['user_id']}/send-link").json()["sent"]
    assert outbox[-1]["to"] == mate["email"] and "set-password?token=" in outbox[-1]["action"][1]
    assert boss.delete(f"/admin/orgs/{o['id']}/people/{mate['user_id']}/mfa").status_code == 409
    sql("UPDATE users SET totp_secret = 'v1:x', totp_enabled_at = now() WHERE id = %s", mate["user_id"])
    assert boss.delete(f"/admin/orgs/{o['id']}/people/{mate['user_id']}/mfa").status_code == 204
    assert "turned off" in outbox[-1]["subject"]
    stranger = Actor(client, "Stranger")
    assert boss.post(f"/admin/orgs/{o['id']}/owner", json={"user_id": stranger.id}).status_code == 404
    after = boss.post(f"/admin/orgs/{o['id']}/owner", json={"user_id": mate["user_id"]}).json()
    assert [(p["name"], p["role"]) for p in after["people"]] == [("Bola Ade", "owner"), ("Ada Obi", "admin")]

    # everything staff did, in one log, filterable by customer
    acts = boss.get("/admin/activity", params={"org_id": o["id"]}).json()
    assert [a["action"] for a in acts][:5] == ["platform.owner_transfer", "platform.mfa_reset", "platform.send_link",
                                              "platform.note_delete", "platform.note_add"]
    assert all(a["org_name"] == o["name"] and a["actor_name"] == "Idris Super" for a in acts)
    assert all(a["action"].startswith("platform.") for a in boss.get("/admin/activity").json())
