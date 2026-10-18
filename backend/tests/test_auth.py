from app.config import settings
from conftest import Actor


def test_register_login_me(client):
    a = Actor(client, "Ada")
    assert a.get("/me").json()["email"] == a.email
    r = client.post("/auth/login", json={"email": a.email.upper(), "password": a.password})
    assert r.status_code == 200 and r.json()["expires_in"] == settings.access_token_minutes * 60


def test_errors_are_problem_json(client):
    r = client.post("/auth/login", json={"email": "nobody@example.com", "password": "whatever123"})
    assert r.status_code == 401 and r.headers["content-type"].startswith("application/problem+json")
    body = r.json()
    assert {"type", "title", "status", "detail"} <= body.keys() and body["status"] == 401
    r = client.post("/auth/register", json={"email": "bad", "password": "x", "name": ""})
    assert r.status_code == 422 and {"email", "password", "name"} <= r.json()["fields"].keys()
    assert client.get("/me").status_code == 401


def test_duplicate_email(client):
    a = Actor(client)
    r = client.post("/auth/register", json={"email": a.email, "password": "another-password", "name": "X"})
    assert r.status_code == 409 and r.json()["code"] == "email_taken"


def test_refresh_rotation_and_reuse_detection(client):
    a = Actor(client)
    old = a.tokens["refresh_token"]
    r = client.post("/auth/refresh", json={"refresh_token": old})
    assert r.status_code == 200
    new = r.json()["refresh_token"]
    assert new != old
    # replaying the old token is theft: it fails AND kills the new token too
    assert client.post("/auth/refresh", json={"refresh_token": old}).json()["code"] == "token_reused"
    assert client.post("/auth/refresh", json={"refresh_token": new}).status_code == 401


def test_logout_revokes_session(client):
    a = Actor(client)
    assert client.post("/auth/logout", json={"refresh_token": a.tokens["refresh_token"]}).status_code == 204
    assert client.post("/auth/refresh", json={"refresh_token": a.tokens["refresh_token"]}).status_code == 401


def test_login_rate_limit(client, monkeypatch):
    monkeypatch.setattr(settings, "rate_login_per_min", 3)
    codes = [client.post("/auth/login", json={"email": "x@example.com", "password": "nope-nope-1"}).status_code
             for _ in range(5)]
    assert codes[:3] == [401] * 3 and codes[3:] == [429] * 2
    r = client.post("/auth/login", json={"email": "x@example.com", "password": "nope-nope-1"})
    assert "retry-after" in r.headers
