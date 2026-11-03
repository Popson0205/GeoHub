from datetime import date, timedelta

import pytest

from app.config import settings
from conftest import uid
from test_staff_console import boss, customer, outbox, sql  # noqa: F401  (fixtures)

KEY = "a-crm-link-key-that-is-long-enough-0123456789"


@pytest.fixture
def crm(client, monkeypatch):
    monkeypatch.setattr(settings, "crm_link_key", KEY)

    class Crm:
        h = {"Authorization": f"Bearer {KEY}"}
        def get(self, url, **kw): return client.get(url, headers=self.h, **kw)
        def post(self, url, **kw): return client.post(url, headers=self.h, **kw)
    return Crm()


def test_the_link_is_off_without_a_key_and_needs_the_right_one(client, monkeypatch):
    monkeypatch.setattr(settings, "crm_link_key", "")
    assert client.get("/crm-link/orgs", headers={"Authorization": "Bearer anything"}).status_code == 404
    monkeypatch.setattr(settings, "crm_link_key", KEY)
    assert client.get("/crm-link/orgs").status_code == 401
    r = client.get("/crm-link/orgs", headers={"Authorization": "Bearer " + KEY[:-1] + "x"})
    assert r.status_code == 401 and "GEOHUB_LINK_KEY" in r.json()["detail"]


def test_the_crm_reads_customers_and_requests(client, boss, outbox, crm):
    o = customer(boss)
    listed = crm.get("/crm-link/orgs", params={"q": o["name"]}).json()
    assert [x["id"] for x in listed] == [o["id"]]
    x = listed[0]
    assert x["plan_name"] == "Organization Standard" and x["status"] == "active" and x["status_name"] == "Active"
    assert x["owner_email"] == o["owner_email"] and x["console_url"].endswith(f"/admin/customers/{o['id']}")
    assert [y["id"] for y in crm.get("/crm-link/orgs", params={"ids": o["id"]}).json()] == [o["id"]]
    assert crm.get("/crm-link/orgs", params={"ids": "nope"}).status_code == 422
    assert crm.get(f"/crm-link/orgs/{o['id']}").json()["name"] == o["name"]
    assert crm.get("/crm-link/orgs/00000000-0000-0000-0000-000000000000").status_code == 404

    org = f"Survey Co {uid()}"
    assert client.post("/org-requests", json={"organization": org, "contact_name": "Bola Ade", "email": f"{uid()}@example.com",
                                              "plan": "demo"}).status_code == 202
    assert any(r["organization"] == org and r["plan"] == "demo" for r in crm.get("/crm-link/requests", params={"status": "new"}).json())


def test_the_crm_sets_up_customers_and_switches_on_paid_licences(client, boss, outbox, crm):
    email = f"{uid()}@example.com"
    d = crm.post("/crm-link/orgs", json={"name": f"Abuja Lands {uid()}", "licence_kind": "demo", "owner_name": "Chika Eze",
                                         "owner_email": email, "staff_name": "Funke Ola"})
    assert d.status_code == 201, d.text
    o = d.json()
    assert o["status"] == "demo" and o["plan"] == "advanced" and o["owner_email"] == email
    assert "set-password" in outbox[-1]["action"][1]

    start, end = date.today(), date.today() + timedelta(days=364)
    body = {"plan": "standard", "subscription_starts": start.isoformat(), "subscription_ends": end.isoformat(),
            "invoice_ref": "GE-2026-0007", "staff_name": "Funke Ola"}
    paid = crm.post(f"/crm-link/orgs/{o['id']}/licence", json=body).json()
    assert paid["licence_kind"] == "paid" and paid["status"] == "active" and paid["plan"] == "standard"
    assert paid["subscription_ends"] == end.isoformat() and not paid["already_applied"]
    again = crm.post(f"/crm-link/orgs/{o['id']}/licence", json=body | {"plan": "advanced"}).json()
    assert again["already_applied"] and again["plan"] == "standard"              # an invoice applies once

    detail = boss.get(f"/admin/orgs/{o['id']}").json()
    ev = detail["licences"][0]
    assert ev["invoice_ref"] == "GE-2026-0007" and ev["action"] == "renew" and "Funke Ola" in ev["note"] and ev["kind"] == "paid"
    acts = boss.get("/admin/activity", params={"org_id": o["id"]}).json()
    assert any(a["action"] == "platform.org_update" and a["details"].get("staff") == "Funke Ola" for a in acts)

    # suspended for non-payment: paying lifts it only when asked
    sql("UPDATE organizations SET suspended_at = now(), suspended_reason = 'Unpaid' WHERE id = %s", o["id"])
    nxt = body | {"invoice_ref": "GE-2027-0001", "subscription_starts": (end + timedelta(days=1)).isoformat(),
                  "subscription_ends": (end + timedelta(days=365)).isoformat()}
    assert crm.post(f"/crm-link/orgs/{o['id']}/licence", json=nxt).json()["status"] == "suspended"
    lifted = crm.post(f"/crm-link/orgs/{o['id']}/licence", json=nxt | {"invoice_ref": "GE-2027-0002", "lift_suspension": True}).json()
    assert lifted["status"] == "active"
    bad = crm.post(f"/crm-link/orgs/{o['id']}/licence", json=body | {"invoice_ref": "x", "subscription_ends": "2000-01-01"})
    assert bad.status_code == 422
