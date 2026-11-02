import re
import time
from urllib.parse import parse_qs, urlparse

import httpx
import jwt
import psycopg
import pytest

from app.config import settings
from conftest import Actor, set_plan, uid


@pytest.fixture
def outbox(monkeypatch):
    sent = []

    async def fake(to, subject, body, *, action=None, key=None, raise_errors=False):
        sent.append({"to": to, "subject": subject, "body": body, "action": action})
        return True
    from app import signup
    from app.routers import admin, auth, org
    for m in (signup, admin, auth, org):
        monkeypatch.setattr(m, "send_email", fake)
    return sent


@pytest.fixture
def idp(monkeypatch):
    """Google and Microsoft, faked: whatever claims the test puts in `idp.claims` come back in the ID token."""
    from app.routers import sso
    for k, v in {"google_client_id": "g-client", "google_client_secret": "g-secret", "microsoft_client_id": "m-client",
                 "microsoft_client_secret": "m-secret", "microsoft_tenant": "common"}.items():
        monkeypatch.setattr(settings, k, v)

    class Idp:
        claims: dict = {}
        posts: list = []
    i = Idp()

    def handle(request: httpx.Request) -> httpx.Response:
        i.posts.append(parse_qs(request.content.decode()))
        return httpx.Response(200, json={"access_token": "x", "id_token": jwt.encode(i.claims, "not-checked", algorithm="HS256")})
    monkeypatch.setattr(sso, "transport", httpx.MockTransport(handle))
    return i


def sign_in(client, idp, provider, **claims):
    """Run the whole browser flow; returns the final response of the exchange, or the error message."""
    r = client.get(f"/auth/sso/{provider}/start", params={"next": "/maps"}, follow_redirects=False)
    assert r.status_code == 302, r.text
    q = parse_qs(urlparse(r.headers["location"]).query)
    base = {"aud": f"{provider[0]}-client", "exp": int(time.time()) + 300, "nonce": q["nonce"][0], "sub": uid()}
    base |= ({"iss": "https://accounts.google.com", "email_verified": True} if provider == "google"
             else {"tid": "tenant-1", "iss": "https://login.microsoftonline.com/tenant-1/v2.0"})
    idp.claims = base | claims
    cb = client.get(f"/auth/sso/{provider}/callback", params={"code": "the-code", "state": q["state"][0]}, follow_redirects=False)
    assert cb.status_code == 303
    to = urlparse(cb.headers["location"])
    params = parse_qs(to.query)
    if to.path.endswith("/login"):
        return params["sso_error"][0]
    assert to.path.endswith("/sso") and params["next"] == ["/maps"]
    out = client.post("/auth/sso/exchange", json={"code": params["code"][0]})
    assert out.status_code == 200, out.text
    assert client.post("/auth/sso/exchange", json={"code": params["code"][0]}).status_code == 401    # once only
    return out.json()


def test_providers_are_offered_only_when_set_up(client, idp, monkeypatch):
    assert client.get("/auth/providers").json() == {"providers": ["google", "microsoft"]}
    monkeypatch.setattr(settings, "microsoft_client_secret", "")
    assert client.get("/auth/providers").json() == {"providers": ["google"]}
    assert client.get("/auth/sso/microsoft/start", follow_redirects=False).status_code == 404


def test_google_sign_in_makes_an_account_then_signs_back_in(client, idp, outbox):
    email = f"{uid()}@example.com"
    sub = uid()
    first = sign_in(client, idp, "google", email=email, sub=sub, name="Ngozi Eze")
    assert first["user"]["email"] == email and first["user"]["name"] == "Ngozi Eze"
    assert first["user"]["org"]["plan"] == "individual" and first["user"]["org"]["role"] == "owner"
    assert idp.posts[-1]["client_secret"] == ["g-secret"] and idp.posts[-1]["code"] == ["the-code"]
    again = sign_in(client, idp, "google", email="changed@example.com", sub=sub)
    assert again["user"]["id"] == first["user"]["id"]          # matched by Google's id, not the email


def test_existing_password_account_is_linked_by_proven_email(client, idp):
    me = Actor(client, "Has Password")
    out = sign_in(client, idp, "google", email=me.email.upper())
    assert out["user"]["id"] == me.id
    assert "did not confirm" in sign_in(client, idp, "google", email=f"{uid()}@example.com", email_verified=False)


def test_microsoft_work_email_must_be_verified(client, idp):
    me = Actor(client, "Victim")
    # an Entra tenant can put any address in "email": without xms_edov it does not prove ownership
    assert "did not confirm" in sign_in(client, idp, "microsoft", email=me.email)
    ok = sign_in(client, idp, "microsoft", email=me.email, xms_edov=True)
    assert ok["user"]["id"] == me.id
    personal = sign_in(client, idp, "microsoft", email=f"{uid()}@example.com", tid="9188040d-6c67-4c5b-b112-36a304b66dad",
                       iss="https://login.microsoftonline.com/9188040d-6c67-4c5b-b112-36a304b66dad/v2.0")
    assert personal["user"]["org"]["plan"] == "individual"


def test_bad_answers_are_refused(client, idp):
    assert "not meant for this app" in sign_in(client, idp, "google", email=f"{uid()}@example.com", aud="someone-else")
    assert "issuer" in sign_in(client, idp, "google", email=f"{uid()}@example.com", iss="https://evil.example.com")
    assert "matched" in sign_in(client, idp, "google", email=f"{uid()}@example.com", nonce="wrong")
    # a callback without this browser's cookie (someone else's link) is refused
    r = client.get("/auth/sso/google/start", follow_redirects=False)
    state = parse_qs(urlparse(r.headers["location"]).query)["state"][0]
    client.cookies.clear()
    cb = client.get("/auth/sso/google/callback", params={"code": "c", "state": state}, follow_redirects=False)
    assert "sso_error" in cb.headers["location"] and "browser" in parse_qs(urlparse(cb.headers["location"]).query)["sso_error"][0]
    cancelled = client.get("/auth/sso/google/callback", params={"error": "access_denied"}, follow_redirects=False)
    assert "cancelled" in parse_qs(urlparse(cancelled.headers["location"]).query)["sso_error"][0]


def _verify(org_id, domain):
    with psycopg.connect(settings.database_url, autocommit=True) as c:
        c.execute("UPDATE org_domains SET verified_at = now() WHERE domain = %s AND org_id = %s", (domain, org_id))


def test_domains_are_for_paid_plans_and_must_be_proven(client, outbox, monkeypatch):
    solo = Actor(client, "Student", plan=None)
    assert solo.post("/org/domains", json={"domain": "student.example.com"}).status_code == 403
    boss = Actor(client, "Boss", plan="standard")
    assert boss.post("/org/domains", json={"domain": "gmail.com"}).status_code == 422
    assert boss.post("/org/domains", json={"domain": "not a domain"}).status_code == 422
    dom = f"{uid()}.example.com"
    r = boss.post("/org/domains", json={"domain": f"  @{dom.upper()} "})
    assert r.status_code == 201 and r.json()["domain"] == dom and not r.json()["verified"]
    record = r.json()["record"]
    assert record["type"] == "TXT" and record["value"].startswith("geohub-verification=")
    other = Actor(client, "Rival", plan="advanced")
    assert other.post("/org/domains", json={"domain": dom}).status_code == 409

    from app import domains
    answers = {"Answer": []}
    monkeypatch.setattr(domains, "transport", httpx.MockTransport(lambda req: httpx.Response(200, json=answers)))
    bad = boss.post(f"/org/domains/{dom}/verify")
    assert bad.status_code == 422 and record["value"] in bad.json()["detail"]
    answers["Answer"] = [{"name": dom, "type": 16, "data": f'"v=spf1 -all"'}, {"name": dom, "type": 16, "data": f'"{record["value"]}"'}]
    good = boss.post(f"/org/domains/{dom}/verify")
    assert good.status_code == 200 and good.json()["verified"]
    p = boss.patch(f"/org/domains/{dom}", json={"role": "collector", "auto_join": False})
    assert p.json()["role"] == "collector" and p.json()["auto_join"] is False
    assert boss.delete(f"/org/domains/{dom}").status_code == 204
    assert boss.get("/org/domains").json() == []


def test_people_join_by_domain_once_their_email_is_proven(client, idp, outbox):
    boss = Actor(client, "Boss", plan="standard")
    dom = f"{uid()}.example.com"
    boss.post("/org/domains", json={"domain": dom})
    # with Google: straight in, with the domain's role
    boss.patch(f"/org/domains/{dom}", json={"role": "collector"})
    assert sign_in(client, idp, "google", email=f"a@{dom}")["user"]["org"]["id"] != boss.org_id    # not verified yet
    _verify(boss.org_id, dom)
    via_google = sign_in(client, idp, "google", email=f"b@{dom}")
    assert via_google["user"]["org"]["id"] == boss.org_id and via_google["user"]["org"]["role"] == "collector"

    # with a password: their own account first, and an email to confirm and join
    r = client.post("/auth/register", json={"email": f"c@{dom}", "password": "correct-horse-battery", "name": "Chika Obi"})
    assert r.json()["user"]["org"]["plan"] == "individual"
    mail = outbox[-1]
    assert mail["to"] == f"c@{dom}" and boss.get("/org").json()["name"] in mail["subject"]
    token = re.search(r"token=([\w-]+)", mail["action"][1]).group(1)
    link = client.get(f"/auth/password-link/{token}").json()
    assert link["purpose"] == "join" and link["org_name"] == boss.get("/org").json()["name"]
    assert client.post("/auth/set-password", json={"token": token, "password": "another-long-one"}).status_code == 404
    joined = client.post("/auth/join-organization", json={"token": token})
    assert joined.status_code == 200 and joined.json()["user"]["org"]["id"] == boss.org_id
    assert client.post("/auth/join-organization", json={"token": token}).status_code == 410

    # joining off: nobody new joins
    boss.patch(f"/org/domains/{dom}", json={"auto_join": False})
    assert sign_in(client, idp, "google", email=f"d@{dom}")["user"]["org"]["id"] != boss.org_id


def test_a_full_organization_does_not_block_sign_up(client, idp):
    boss = Actor(client, "Boss", plan="standard")
    set_plan(boss.org_id, "standard", seats=1)
    dom = f"{uid()}.example.com"
    boss.post("/org/domains", json={"domain": dom})
    _verify(boss.org_id, dom)
    out = sign_in(client, idp, "google", email=f"late@{dom}")
    assert out["user"]["org"]["id"] != boss.org_id and out["user"]["org"]["plan"] == "individual"


def test_staff_can_add_a_verified_domain(client, monkeypatch):
    staff = Actor(client, "Staff", plan=None)
    monkeypatch.setattr(settings, "platform_admins", staff.email)
    boss = Actor(client, "Boss", plan="advanced")
    dom = f"{uid()}.example.com"
    r = staff.post(f"/admin/orgs/{boss.org_id}/domains", json={"domain": dom})
    assert r.status_code == 201 and r.json()["verified"]
    assert boss.get("/org/domains").json()[0]["verified"]
    listed = next(o for o in staff.get("/admin/orgs").json() if o["id"] == boss.org_id)
    assert listed["domains"] == [dom]
