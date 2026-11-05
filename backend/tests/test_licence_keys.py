from datetime import date, timedelta

import pytest

from app import licence_keys
from app.config import settings
from conftest import Actor
from test_staff_console import boss, customer, outbox, sql  # noqa: F401  (fixtures)

SECRET = "geoestate-licence-signing-secret-0123456789"
SITE = "https://geohub.lands.example.gov.ng"


@pytest.fixture
def issuer(monkeypatch):
    monkeypatch.setattr(settings, "licence_signing_secret", SECRET)


def test_staff_issue_a_key_carrying_the_customers_licences(client, boss, outbox, issuer):
    s = boss.get("/admin/licence-keys").json()
    assert s["can_issue"] and len(s["public_key"]) == 43
    o = customer(boss)
    boss.put(f"/admin/orgs/{o['id']}/products/land", json={"plan": "advanced", "subscription_starts": date.today().isoformat(),
                                                           "subscription_ends": (date.today() + timedelta(days=364)).isoformat(),
                                                           "features": {"ai_georeference": False}})
    r = boss.post(f"/admin/orgs/{o['id']}/licence-keys", json={"installation": SITE + "/some/path", "note": "Lands bureau data centre"})
    assert r.status_code == 201, r.text
    k = r.json()
    assert k["key"].startswith("GEOESTATE-LICENCE-1.") and k["installation"] == SITE
    assert [(p["product"], p["plan_name"]) for p in k["products"]] == [("hub", "Organization Standard"), ("land", "Land Registry Advanced")]
    detail = boss.get(f"/admin/orgs/{o['id']}").json()
    assert detail["licence_keys"][0]["id"] == k["id"] and detail["licence_keys"][0]["issued_by"]
    assert boss.get(f"/admin/licence-keys/{k['id']}").json()["key"] == k["key"]
    support = Actor(client, "Support Person", plan=None)
    boss.post("/admin/staff", json={"email": support.email, "role": "support"})
    assert support.post(f"/admin/orgs/{o['id']}/licence-keys", json={"installation": SITE}).status_code == 403
    assert boss.post(f"/admin/orgs/{o['id']}/licence-keys", json={"installation": "not a web address"}).status_code == 422

    # the key reads back only when unchanged and only on its own installation
    payload = licence_keys.read(k["key"], SITE)
    assert payload["customer"] == o["name"] and payload["products"][1]["features"] == {"ai_georeference": False}
    with pytest.raises(Exception) as e:
        licence_keys.read(k["key"], "https://another.example")
    assert "not this installation" in str(e.value.detail)
    head, body, sig = k["key"].split(".")
    tampered = body[:-2] + ("A" if body[-2] != "A" else "B") + body[-1]
    with pytest.raises(Exception) as e:
        licence_keys.read(f"{head}.{tampered}.{sig}", SITE)
    assert e.value.code in ("bad_signature", "bad_key")
    wrapped = "\n".join(k["key"][i:i + 64] for i in range(0, len(k["key"]), 64))
    assert licence_keys.read(wrapped, SITE)["id"] == k["id"]          # a key wrapped over lines still reads


def test_an_installation_takes_its_licences_from_the_key(client, boss, outbox, issuer, monkeypatch):
    cloud = customer(boss, plan="advanced")
    boss.put(f"/admin/orgs/{cloud['id']}/products/farm", json={"plan": "standard", "subscription_starts": date.today().isoformat(),
                                                               "subscription_ends": (date.today() + timedelta(days=200)).isoformat()})
    ends = date.today() + timedelta(days=500)
    k = boss.post(f"/admin/orgs/{cloud['id']}/licence-keys", json={"installation": SITE, "ends": ends.isoformat()}).json()

    # now act as the customer's installation: it trusts GeoEstate's public key, not the secret
    public = licence_keys.public_key()
    monkeypatch.setattr(settings, "licence_signing_secret", "")
    monkeypatch.setattr(settings, "licence_public_key", public)
    monkeypatch.setattr(settings, "app_url", SITE)
    owner = Actor(client, "Install Owner", plan="standard")
    sql("DELETE FROM installation_licence")
    assert owner.get("/org/licence-key").json()["installed"] is None
    assert owner.put("/org/licence-key", json={"key": k["key"]}).status_code == 409        # not a licence installation
    monkeypatch.setattr(settings, "licence_required", True)
    bad = owner.put("/org/licence-key", json={"key": k["key"][:-6] + "AAAAAA"})
    assert bad.status_code == 422
    r = owner.put("/org/licence-key", json={"key": k["key"]})
    assert r.status_code == 200, r.text
    assert r.json()["installed"]["id"] == k["id"]
    prods = {p["product"]: p for p in owner.get("/org/products").json()}
    assert prods["hub"]["plan"] == "advanced" and prods["hub"]["subscription_ends"] == ends.isoformat()
    assert prods["farm"]["status"] == "active" and prods["farm"]["subscription_ends"] == ends.isoformat()
    org = owner.get("/org").json()
    assert org["plan"] == "advanced"

    # a later key without FarmScan takes it away; a member cannot install keys
    monkeypatch.setattr(settings, "licence_signing_secret", SECRET)
    monkeypatch.setattr(settings, "app_url", "http://localhost:5173")
    boss.post(f"/admin/orgs/{cloud['id']}/products/farm/remove", json={"note": "Not renewed"})
    k2 = boss.post(f"/admin/orgs/{cloud['id']}/licence-keys", json={"installation": SITE}).json()
    monkeypatch.setattr(settings, "licence_signing_secret", "")
    monkeypatch.setattr(settings, "app_url", SITE)
    r = owner.put("/org/licence-key", json={"key": k2["key"]}).json()
    assert r["installed"]["id"] == k2["id"]
    assert [p["product"] for p in owner.get("/org/products").json()] == ["hub"]

    # renewing works even when the installation is closed
    sql("UPDATE organizations SET suspended_at = now() WHERE id = %s", owner.org_id)
    assert owner.put("/org/licence-key", json={"key": k2["key"]}).status_code == 200
    sql("UPDATE organizations SET suspended_at = NULL WHERE id = %s", owner.org_id)


def test_pinned_keys_win_over_the_setting(monkeypatch, issuer):
    k = licence_keys.sign({"id": "x", "installation": SITE, "products": [], "customer": "C", "issued_at": "now"})
    monkeypatch.setattr(settings, "licence_signing_secret", "")
    monkeypatch.setattr(settings, "licence_public_key", "AAAA" * 10 + "AAA")       # someone points the setting elsewhere
    monkeypatch.setattr(licence_keys, "PINNED", ())
    with pytest.raises(Exception):
        licence_keys.read(k, SITE)
    monkeypatch.setattr(settings, "licence_signing_secret", SECRET)
    good = licence_keys.public_key()
    monkeypatch.setattr(settings, "licence_signing_secret", "")
    monkeypatch.setattr(licence_keys, "PINNED", (good,))
    assert licence_keys.read(k, SITE)["customer"] == "C"


def test_an_installation_without_a_key_starts_its_grace_period(client, boss, outbox, issuer, monkeypatch):
    import asyncio
    import psycopg
    from psycopg.rows import dict_row
    o = customer(boss, subscription_ends=None, subscription_starts=None)
    monkeypatch.setattr(settings, "licence_required", True)

    async def go():
        c = await psycopg.AsyncConnection.connect(settings.database_url, row_factory=dict_row)
        try:
            await c.execute("DELETE FROM installation_licence")
            await licence_keys.on_start(c)
            cur = await c.execute("SELECT subscription_ends = current_date AS today FROM organizations WHERE id = %s", (o["id"],))
            return (await cur.fetchone())["today"]
        finally:
            await c.rollback()                                   # leave the shared test database as it was
            await c.close()
    assert asyncio.run(go()) is True
