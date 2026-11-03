import re
from datetime import date, timedelta

import pytest

from app.config import settings
from conftest import Actor, uid


@pytest.fixture
def outbox(monkeypatch):
    sent = []

    async def fake(to, subject, body, *, action=None, key=None, raise_errors=False, brand=None):
        sent.append({"to": to, "subject": subject, "body": body, "action": action, "brand": brand})
        return True
    from app import reminders
    from app.routers import admin, auth, org
    for m in (admin, auth, org, reminders):
        monkeypatch.setattr(m, "send_email", fake)
    return sent


@pytest.fixture
def staff(client, monkeypatch):
    a = Actor(client, "GeoEstate Staff", plan=None)
    monkeypatch.setattr(settings, "platform_admins", f"someone@example.com, {a.email.upper()}")
    return a


def test_only_platform_admins_see_the_admin_api(client, staff):
    other = Actor(client, "Client")
    assert other.get("/admin/orgs").status_code == 404
    assert other.get("/admin/requests").status_code == 404
    assert other.get("/me").json()["platform_admin"] is False
    assert staff.get("/me").json()["platform_admin"] is True
    assert staff.get("/admin/orgs").status_code == 200


def test_set_up_an_organization_with_a_new_owner(client, staff, outbox):
    email, name = f"{uid()}@example.com", f"Lagos Survey {uid()}"
    ends = (date.today() + timedelta(days=365)).isoformat()
    r = staff.post("/admin/orgs", json={"name": name, "plan": "standard", "owner_name": "Ada Obi",
                                        "owner_email": email, "subscription_starts": date.today().isoformat(),
                                        "subscription_ends": ends, "limits": {"collectors": 80}})
    assert r.status_code == 201, r.text
    o = r.json()
    assert o["plan_name"] == "Organization Standard" and o["owner_email"] == email and o["days_left"] == 365
    assert o["caps"] == {"seats": 10, "collectors": 80, "viewers": 50, "teams": 2} and o["usage"]["seats"] == 1
    mail = outbox[-1]
    assert mail["to"] == email and name in mail["subject"]
    token = re.search(r"token=([\w-]+)", mail["action"][1]).group(1)
    assert client.post("/auth/set-password", json={"token": token, "password": "a-good-long-password"}).status_code == 200
    login = client.post("/auth/login", json={"email": email, "password": "a-good-long-password"}).json()
    assert login["user"]["org"]["role"] == "owner" and login["user"]["org"]["plan"] == "standard"

    # listed, searchable, editable
    assert [x["id"] for x in staff.get("/admin/orgs", params={"q": name.lower()}).json()] == [o["id"]]
    p = staff.patch(f"/admin/orgs/{o['id']}", json={"plan": "advanced", "limits": {}})
    assert p.json()["plan"] == "advanced" and p.json()["caps"]["seats"] == 30
    bad = staff.patch(f"/admin/orgs/{o['id']}", json={"subscription_ends": "2000-01-01"})
    assert bad.status_code == 422
    assert staff.patch(f"/admin/orgs/{o['id']}", json={"clear_dates": True}).json()["subscription_ends"] is None


def test_an_owner_who_signed_up_alone_is_moved_in_but_not_one_with_work(client, staff, outbox):
    fresh = Actor(client, "Fresh Person", plan=None)
    r = staff.post("/admin/orgs", json={"name": "Fresh Co", "plan": "advanced", "owner_name": "x", "owner_email": fresh.email})
    assert r.status_code == 201
    assert fresh.get("/org").json()["name"] == "Fresh Co" and "usual password" in outbox[-1]["body"]

    busy = Actor(client, "Busy Person")
    busy.post("/projects", json={"name": "Work"})
    r = staff.post("/admin/orgs", json={"name": "Busy Co", "plan": "standard", "owner_name": "x", "owner_email": busy.email})
    assert r.status_code == 409 and r.json()["code"] == "other_organization"


def test_public_request_form_reaches_staff_and_can_be_set_up(client, staff, outbox):
    email = f"{uid()}@example.com"
    r = client.post("/org-requests", json={"organization": "Abuja Estates", "contact_name": "Musa Bello", "email": email,
                                           "plan": "advanced", "team_size": "20 staff, 100 collectors", "message": "Hi"})
    assert r.status_code == 202
    assert {"someone@example.com", staff.email.lower(), email} <= {m["to"] for m in outbox}   # plus any staff from the console
    # robots that fill the hidden field are thanked and forgotten
    assert client.post("/org-requests", json={"organization": "Spam", "contact_name": "Bot", "email": f"{uid()}@example.com",
                                              "plan": "unsure", "website": "http://spam"}).status_code == 202
    reqs = staff.get("/admin/requests").json()
    assert reqs[0]["organization"] == "Abuja Estates" and all(x["organization"] != "Spam" for x in reqs)
    rid = reqs[0]["id"]
    assert staff.patch(f"/admin/requests/{rid}", json={"status": "contacted", "note": "Invoice sent"}).json()["status"] == "contacted"
    o = staff.post("/admin/orgs", json={"name": "Abuja Estates", "plan": "advanced", "owner_name": "Musa Bello",
                                        "owner_email": email, "request_id": rid}).json()
    done = next(x for x in staff.get("/admin/requests").json() if x["id"] == rid)
    assert done["status"] == "set_up" and done["org_id"] == o["id"] and done["note"] == "Invoice sent"


def test_renewal_reminders_go_once_at_each_step(client, staff, outbox):
    from app import reminders
    from app.db import pool
    owner_email = f"{uid()}@example.com"
    today = date.today() + timedelta(days=3000)          # far ahead, so other tests' organizations are not due
    ends = today + timedelta(days=30)
    o = staff.post("/admin/orgs", json={"name": "Renew Me", "plan": "standard", "owner_name": "Owner",
                                        "owner_email": owner_email, "subscription_ends": ends.isoformat()}).json()
    outbox.clear()

    async def run(day):
        async with pool.connection() as conn:
            return await reminders.run(conn, day)
    def call(day):                                       # on the app's own event loop, where the pool lives
        return client.portal.call(run, day)

    assert call(today) == 1
    to_owner = [m for m in outbox if m["to"] == owner_email]
    assert len(to_owner) == 1 and "ends in 30 days" in to_owner[0]["subject"] and "Renew Me" in to_owner[0]["body"]
    assert any(m["to"] == staff.email.lower() and "Renewal: Renew Me" in m["subject"] for m in outbox)
    assert call(today) == 0                                # already sent today
    assert call(today + timedelta(days=1)) == 0            # 29 days: not a reminder day
    assert call(ends) == 1
    assert any("ends today" in m["subject"] for m in outbox if m["to"] == owner_email)
    # renewing moves the end date, and the reminders start over for it
    staff.patch(f"/admin/orgs/{o['id']}", json={"subscription_ends": (ends + timedelta(days=365)).isoformat()})
    assert call(ends + timedelta(days=365 - 60)) == 1
