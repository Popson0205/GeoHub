from datetime import date, timedelta

from app import reminders
from app.config import settings
from conftest import Actor
from test_crm_link import KEY, crm  # noqa: F401  (fixture)
from test_staff_console import boss, customer, outbox, sql, staff_member  # noqa: F401  (fixtures)


def test_staff_give_a_customer_other_products(client, boss, outbox, monkeypatch):
    monkeypatch.setattr(settings, "product_urls", "land=https://land.example/,farm=https://farm.example")
    o = customer(boss)
    detail = boss.get(f"/admin/orgs/{o['id']}").json()
    assert [p["product"] for p in detail["products"]] == ["hub"] and detail["products"][0]["name"] == "Geohub"

    r = boss.put(f"/admin/orgs/{o['id']}/products/land", json={"plan": "standard", "licence_kind": "demo", "note": "Pilot"})
    assert r.status_code == 200, r.text
    land = next(p for p in r.json() if p["product"] == "land")
    assert land["status"] == "demo" and land["plan_name"] == "Land Registry Standard" and land["url"] == "https://land.example"
    assert "public_lookup" in land["features"] and "dxf_import" not in land["features"] and land["limits"]["parcels"] == 20000

    end = date.today() + timedelta(days=364)
    paid = boss.put(f"/admin/orgs/{o['id']}/products/land", json={
        "plan": "advanced", "subscription_starts": date.today().isoformat(), "subscription_ends": end.isoformat(),
        "features": {"ai_georeference": False}, "limits": {"parcels": 400000}, "invoice_ref": "GE-2026-0100"}).json()
    land = next(p for p in paid if p["product"] == "land")
    assert land["status"] == "active" and land["licence_kind"] == "paid" and "dxf_import" in land["features"]
    assert "ai_georeference" not in land["features"] and land["limits"]["parcels"] == 400000
    assert boss.put(f"/admin/orgs/{o['id']}/products/land", json={"features": {"teleport": True}}).status_code == 422
    assert boss.put(f"/admin/orgs/{o['id']}/products/hub", json={}).status_code == 422
    assert boss.put(f"/admin/orgs/{o['id']}/products/gold", json={}).status_code == 422

    hist = boss.get(f"/admin/orgs/{o['id']}").json()["licences"]
    assert [(e["product"], e["action"]) for e in hist[:2]] == [("land", "renew"), ("land", "demo")]
    assert hist[0]["invoice_ref"] == "GE-2026-0100"

    # roles: support cannot; members of the organization see what they have
    support = staff_member(client, boss, "support")
    assert support.put(f"/admin/orgs/{o['id']}/products/farm", json={}).status_code == 403

    # suspending the organization suspends every product
    sql("UPDATE organizations SET suspended_at = now() WHERE id = %s", o["id"])
    assert {p["status"] for p in boss.get(f"/admin/orgs/{o['id']}").json()["products"]} == {"suspended"}
    sql("UPDATE organizations SET suspended_at = NULL WHERE id = %s", o["id"])

    gone = boss.post(f"/admin/orgs/{o['id']}/products/land/remove", json={"note": "Not renewed"}).json()
    assert [p["product"] for p in gone] == ["hub"]
    assert boss.post(f"/admin/orgs/{o['id']}/products/land/remove", json={"note": "again"}).status_code == 404
    assert boss.get(f"/admin/orgs/{o['id']}").json()["licences"][0]["action"] == "remove"


def test_members_see_their_products_and_individuals_cannot_have_any(client, boss, outbox):
    solo = Actor(client, "Solo Person", plan=None)
    me = solo.get("/org/products").json()
    assert [(p["product"], p["status"]) for p in me] == [("hub", "free")]
    assert boss.put(f"/admin/orgs/{solo.org_id}/products/farm", json={}).status_code == 409
    team = Actor(client, "Team Lead")                                   # an Organization Advanced customer
    boss.put(f"/admin/orgs/{team.org_id}/products/farm", json={"plan": "advanced", "licence_kind": "demo"})
    mine = team.get("/org/products").json()
    assert [(p["product"], p["status"]) for p in mine] == [("hub", "active"), ("farm", "demo")]
    assert "drone" in mine[1]["features"] and mine[1]["name"] == "FarmScan"


def test_the_crm_switches_on_any_product(client, boss, outbox, crm):
    o = customer(boss)
    start, end = date.today(), date.today() + timedelta(days=364)
    body = {"product": "check", "plan": "advanced", "subscription_starts": start.isoformat(), "subscription_ends": end.isoformat(),
            "invoice_ref": "GE-2026-0200", "staff_name": "Femi Cash"}
    r = crm.post(f"/crm-link/orgs/{o['id']}/licence", json=body)
    assert r.status_code == 200, r.text
    check = next(p for p in r.json()["products"] if p["product"] == "check")
    assert check["status"] == "active" and check["plan_name"] == "LandCheck Advanced"
    hub = next(p for p in r.json()["products"] if p["product"] == "hub")
    assert hub["plan"] == "standard" and r.json()["plan"] == "standard"           # Geohub's own licence is untouched
    assert crm.post(f"/crm-link/orgs/{o['id']}/licence", json=body | {"plan": "standard"}).json()["already_applied"]
    # the same invoice number for another product is a different licence
    farm = crm.post(f"/crm-link/orgs/{o['id']}/licence", json=body | {"product": "farm"}).json()
    assert {p["product"] for p in farm["products"]} == {"hub", "check", "farm"}
    assert crm.post(f"/crm-link/orgs/{o['id']}/licence", json=body | {"product": "land", "plan": "individual",
                                                                      "invoice_ref": "x"}).status_code == 422
    listed = next(x for x in crm.get("/crm-link/orgs", params={"q": o["name"]}).json() if x["id"] == o["id"])
    assert len(listed["products"]) == 3


def test_product_renewal_reminders(client, boss, outbox):
    o = customer(boss)
    ends = date.today() + timedelta(days=5000)                 # far ahead: only this licence is due on that day
    boss.put(f"/admin/orgs/{o['id']}/products/farm", json={"plan": "standard", "subscription_starts": date.today().isoformat(),
                                                           "subscription_ends": ends.isoformat()})
    import asyncio
    import psycopg
    from psycopg.rows import dict_row

    async def go():
        async with await psycopg.AsyncConnection.connect(settings.database_url, row_factory=dict_row, autocommit=True) as c:
            return await reminders.run(c, today=ends - timedelta(days=30))
    outbox.clear()
    assert asyncio.run(go()) >= 1
    mine = [m for m in outbox if "FarmScan" in m["subject"]]
    assert mine and "30 days" in mine[0]["subject"] + mine[0]["body"]
    outbox.clear()
    asyncio.run(go())                                            # each reminder goes once
    assert not [m for m in outbox if "FarmScan" in m["subject"]]
