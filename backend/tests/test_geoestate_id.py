import json
import sys
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest

from app.config import settings
from conftest import Actor
from test_staff_console import boss, outbox, sql  # noqa: F401  (fixtures)

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "clients" / "python"))
from geoestate_id import GeoEstateID, GeoEstateIDError  # noqa: E402

SECRET = "land-app-secret-that-is-long-enough-0123"
CALLBACK = "https://land.example/auth/callback"


class Through(httpx.BaseTransport):
    """The kit's HTTP calls, answered by the test app."""
    def __init__(self, client):
        self.c = client

    def handle_request(self, request):
        r = self.c.request(request.method, request.url.path, content=request.read(), headers=dict(request.headers))
        return httpx.Response(r.status_code, headers=r.headers, content=r.content, request=request)


@pytest.fixture
def apps(client, monkeypatch):
    monkeypatch.setattr(settings, "id_clients", json.dumps([
        {"id": "land", "redirect_uris": [CALLBACK], "secret": SECRET},
        {"id": "farm", "redirect_uris": ["https://farm.example/cb"]}]))
    return GeoEstateID(geohub=settings.app_url, api="http://testserver", client_id="land", client_secret=SECRET, transport=Through(client))


def code_for(person, verifier, client_id="land", redirect_uri=CALLBACK, **kw):
    r = person.post("/id/authorize", json={"client_id": client_id, "redirect_uri": redirect_uri, "state": "s-123",
                                           "code_challenge": GeoEstateID.challenge(verifier), **kw})
    assert r.status_code == 200, r.text
    q = parse_qs(urlsplit(r.json()["redirect_to"]).query)
    assert q["state"] == ["s-123"] and r.json()["redirect_to"].startswith(CALLBACK if client_id == "land" else "https://farm")
    return q["code"][0]


def test_sign_in_to_another_app_with_geohub(client, boss, outbox, apps):
    cfg = client.get("/id/configuration").json()
    assert cfg["authorization_endpoint"].endswith("/id/authorize") and cfg["jwks_uri"].endswith("/id/jwks")
    assert client.get("/id/clients/land").json() == {"id": "land", "name": "Land Registry", "product": "land"}
    assert client.get("/id/clients/land", params={"redirect_uri": "https://evil.example/cb"}).status_code == 400
    assert client.get("/id/clients/nope").status_code == 400

    p = Actor(client, "Ngozi Field")                          # an Organization Advanced customer, without Land Registry
    v = apps.new_verifier()
    r = p.post("/id/authorize", json={"client_id": "land", "redirect_uri": CALLBACK, "code_challenge": apps.challenge(v)})
    assert r.status_code == 403 and r.json()["code"] == "no_product" and "Land Registry" in r.json()["detail"]
    assert p.post("/id/authorize", json={"client_id": "land", "redirect_uri": "https://evil.example/cb"}).status_code == 400
    assert client.post("/id/authorize", json={"client_id": "land", "redirect_uri": CALLBACK}).status_code == 401

    boss.put(f"/admin/orgs/{p.org_id}/products/land", json={"plan": "advanced", "licence_kind": "demo"})
    tokens = apps.exchange(code_for(p, v), CALLBACK, v)
    me = apps.verify(tokens["access_token"])
    assert me["name"] == "Ngozi Field" and me["org"]["role"] == "owner" and me["aud"] == "land"
    assert me["product"]["id"] == "land" and me["product"]["status"] == "demo" and "dxf_import" in me["product"]["features"]
    assert GeoEstateID.can_write(me) and tokens["expires_in"] == 15 * 60
    assert client.get("/id/userinfo", headers={"Authorization": f"Bearer {tokens['access_token']}"}).json()["email"] == p.email

    # a token is only for its own app, and only Geohub's key signs one
    farm = GeoEstateID(geohub=settings.app_url, api="http://testserver", client_id="farm", transport=Through(client))
    with pytest.raises(GeoEstateIDError):
        farm.verify(tokens["access_token"])
    with pytest.raises(GeoEstateIDError):
        apps.verify(tokens["access_token"][:-4] + "AAAA")
    with pytest.raises(GeoEstateIDError):
        apps.verify(p.tokens["access_token"])                   # a Geohub session token is not an app token

    # refresh tokens are replaced each time; an old one used again ends the session
    again = apps.refresh(tokens["refresh_token"])
    assert apps.verify(again["access_token"])["sub"] == me["sub"]
    with pytest.raises(GeoEstateIDError) as e:
        apps.refresh(tokens["refresh_token"])
    assert "already used" in str(e.value)
    with pytest.raises(GeoEstateIDError):
        apps.refresh(again["refresh_token"])                    # the whole session ended

    # signing out of the app
    t2 = apps.exchange(code_for(p, v), CALLBACK, v)
    apps.sign_out(t2["refresh_token"])
    with pytest.raises(GeoEstateIDError):
        apps.refresh(t2["refresh_token"])

    # losing the product ends access at the next refresh
    t3 = apps.exchange(code_for(p, v), CALLBACK, v)
    boss.post(f"/admin/orgs/{p.org_id}/products/land/remove", json={"note": "Demo over"})
    with pytest.raises(GeoEstateIDError) as e:
        apps.refresh(t3["refresh_token"])
    assert e.value.code == "no_product"


def test_codes_are_used_once_and_checked(client, boss, outbox, apps):
    p = Actor(client, "Code Tester")
    boss.put(f"/admin/orgs/{p.org_id}/products/land", json={"plan": "standard"})
    v = apps.new_verifier()
    code = code_for(p, v)
    with pytest.raises(GeoEstateIDError) as e:
        apps.exchange(code, CALLBACK, apps.new_verifier())       # the wrong verifier burns the code
    assert "PKCE" in str(e.value)
    with pytest.raises(GeoEstateIDError):
        apps.exchange(code, CALLBACK, v)
    code = code_for(p, v)
    with pytest.raises(GeoEstateIDError):
        apps.exchange(code, "https://land.example/other", v)
    code = code_for(p, v)
    wrong = GeoEstateID(geohub=settings.app_url, api="http://testserver", client_id="land", client_secret="x" * 40, transport=Through(client))
    with pytest.raises(GeoEstateIDError) as e:
        wrong.exchange(code, CALLBACK, v)
    assert e.value.code == "invalid_client"
    first = apps.exchange(code, CALLBACK, v)
    with pytest.raises(GeoEstateIDError):
        apps.exchange(code, CALLBACK, v)                          # a code used twice ends what it started
    with pytest.raises(GeoEstateIDError):
        apps.refresh(first["refresh_token"])
    sql("UPDATE id_codes SET expires_at = now() - interval '1 second' WHERE used_at IS NULL")
    code = code_for(p, v)
    sql("UPDATE id_codes SET expires_at = now() - interval '1 second' WHERE used_at IS NULL")
    with pytest.raises(GeoEstateIDError) as e:
        apps.exchange(code, CALLBACK, v)
    assert "expired" in str(e.value)


def test_apps_without_a_secret_use_pkce_and_staff_may_enter(client, boss, outbox, apps):
    p = Actor(client, "Farm Owner")
    boss.put(f"/admin/orgs/{p.org_id}/products/farm", json={"plan": "standard"})
    r = p.post("/id/authorize", json={"client_id": "farm", "redirect_uri": "https://farm.example/cb"})
    assert r.status_code == 400 and r.json()["code"] == "pkce_required"
    v = "a-verifier-" * 5
    code = code_for(p, v, client_id="farm", redirect_uri="https://farm.example/cb")
    t = client.post("/id/token", data={"grant_type": "authorization_code", "client_id": "farm", "code": code,
                                       "redirect_uri": "https://farm.example/cb", "code_verifier": v})
    assert t.status_code == 200 and t.json()["user"]["product"]["id"] == "farm"
    assert client.post("/id/token", data={"grant_type": "password", "client_id": "farm"}).json()["code"] == "unsupported_grant_type"

    # GeoEstate staff may open an app without the product, to help customers
    staff_code = code_for(boss, v, client_id="farm", redirect_uri="https://farm.example/cb")
    st = client.post("/id/token", data={"grant_type": "authorization_code", "client_id": "farm", "code": staff_code,
                                        "redirect_uri": "https://farm.example/cb", "code_verifier": v}).json()
    assert st["user"]["staff_role"] == "super_admin" and st["user"]["product"] is None
