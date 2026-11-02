import io

import pytest
from PIL import Image

from app import branding
from app.mailer import render_html
from conftest import Actor, uid
from test_datasets import export, publish, setup_dataset_project


@pytest.fixture
def outbox(monkeypatch):
    sent = []

    async def fake(to, subject, body, *, action=None, key=None, raise_errors=False, brand=None):
        sent.append({"to": to, "subject": subject, "body": body, "action": action, "brand": brand})
        return True
    from app.routers import org
    monkeypatch.setattr(org, "send_email", fake)
    return sent


def png(w=800, h=200, color=(200, 30, 30, 255), fmt="PNG") -> bytes:
    b = io.BytesIO()
    Image.new("RGBA" if fmt == "PNG" else "RGB", (w, h), color if fmt == "PNG" else color[:3]).save(b, format=fmt)
    return b.getvalue()


def colleague(client, owner, role="viewer") -> Actor:
    """Someone in the owner's organization, not in any of its projects, signed in."""
    email = f"{uid()}@example.com"
    r = owner.post("/org/accounts", json={"name": "Colleague", "email": email, "role": role, "delivery": "temporary"})
    assert r.status_code == 201, r.text
    s = client.post("/auth/login", json={"email": email, "password": r.json()["temporary_password"]}).json()
    a = Actor.__new__(Actor)
    a.c, a.email, a.id, a.h = client, email, s["user"]["id"], {"Authorization": f"Bearer {s['access_token']}"}
    a.org_id = s["user"]["org"]["id"]
    return a


def test_colour_is_made_readable():
    assert branding.normalize_color("0B5CAD") == "#0b5cad"                      # already readable: kept
    yellow = branding.normalize_color("#ffd400")
    assert yellow != "#ffd400" and branding.contrast_with_white(yellow) >= 4.5   # darkened until white text reads
    assert branding.normalize_color("#abc") == branding.readable("#aabbcc")


def test_branding_for_organization_plans(client, outbox):
    solo = Actor(client, "Student", plan=None)
    assert solo.patch("/org/branding", json={"color": "#0b5cad"}).status_code == 403
    boss = Actor(client, "Boss", plan="standard")
    assert boss.patch("/org/branding", json={"color": "purple"}).status_code == 422
    assert boss.patch("/org/branding", json={"reply_to": "not an email"}).status_code == 422
    r = boss.patch("/org/branding", json={"color": "#0B5CAD", "sender_name": ' Lagos "Survey" <Ltd> ', "reply_to": "Help@Lagos.example.com"})
    assert r.status_code == 200, r.text
    assert r.json()["branding"] == {"color": "#0b5cad", "logo_url": None, "sender_name": "Lagos Survey Ltd", "reply_to": "help@lagos.example.com"}

    bad = boss.c.put("/org/branding/logo", headers=boss.h, files={"file": ("logo.svg", b"<svg onload=alert(1)>", "image/svg+xml")})
    assert bad.status_code == 422
    up = boss.c.put("/org/branding/logo", headers=boss.h, files={"file": ("logo.jpg", png(1600, 400, fmt="JPEG"), "image/jpeg")})
    assert up.status_code == 200, up.text
    url = up.json()["branding"]["logo_url"]
    assert url and f"/orgs/{boss.org_id}/logo?v=" in url
    img = client.get("/" + url.split("/", 3)[3])
    assert img.status_code == 200 and img.headers["content-type"] == "image/png" and "immutable" in img.headers["cache-control"]
    assert Image.open(io.BytesIO(img.content)).size == (512, 128)                 # re-drawn, at most 512 px

    # everyone in the organization gets the brand with their session
    me = client.get("/me", headers=boss.h).json()
    assert me["org"]["brand"] == {"color": "#0b5cad", "logo_url": url}
    # and emails sent for the organization carry it
    boss.post("/org/accounts", json={"name": "New Person", "email": f"{uid()}@example.com", "role": "collector"})
    b = outbox[-1]["brand"]
    assert b["sender_name"] == "Lagos Survey Ltd" and b["reply_to"] == "help@lagos.example.com" and b["logo_url"] == url
    html = render_html("Hello", "Body", ("Go", "https://x.example.com"), b)
    assert "#0b5cad" in html and url in html and "Sent by Geohub for" in html

    gone = boss.c.delete("/org/branding/logo", headers=boss.h)
    assert gone.json()["branding"]["logo_url"] is None and client.get("/" + url.split("/", 3)[3]).status_code == 404
    reset = boss.patch("/org/branding", json={"color": "", "sender_name": "", "reply_to": ""}).json()["branding"]
    assert reset == {"color": None, "logo_url": None, "sender_name": None, "reply_to": None}
    assert client.get("/me", headers=boss.h).json()["org"]["brand"] is None


def test_organization_only_datasets(project, client):
    form_id, _ = setup_dataset_project(project)
    slug = f"org-only-{project.id[:6]}"
    r = publish(project, form_id, slug=slug, visibility="organization", license="Private")
    assert r.status_code == 202, r.text
    mate = colleague(client, project.owner)
    outsider = Actor(client, "Outsider")
    listed = lambda who: slug in [d["slug"] for d in client.get("/datasets", headers=who.h if who else {}).json()["items"]]
    assert listed(mate) and not listed(outsider) and not listed(None)
    assert client.get(f"/datasets/{slug}", headers=mate.h).json()["visibility"] == "organization"
    assert client.get(f"/datasets/{slug}", headers=outsider.h).status_code == 404
    assert client.get(f"/datasets/{slug}").status_code == 404
    assert len(client.get(f"/datasets/{slug}/features", headers=mate.h).json()["features"]) == 2
    job = export(client, slug, "csv", who=mate)                               # their own export job, though not in the project
    assert job["result"]["download_url"]
    assert client.post(f"/datasets/{slug}/exports", headers=outsider.h, json={"format": "csv"}).status_code == 404
    # making it public, then back
    assert project.owner.patch(f"/datasets/{slug}", json={"visibility": "public", "license": "CC-BY-4.0"}).status_code == 200
    assert listed(outsider)


def test_organization_only_needs_an_organization_plan(client, actor):
    solo = actor("Student", plan=None)
    p = solo.post("/projects", json={"name": "Thesis"}).json()
    form = solo.post(f"/projects/{p['id']}/forms", json={"name": "F", "geometry_type": "point", "fields": []}).json()
    solo.post(f"/forms/{form['id']}/publish")
    r = solo.post(f"/projects/{p['id']}/datasets", json={"form_id": form["id"], "slug": f"t-{uid()}", "title": "T", "visibility": "organization"})
    assert r.status_code == 403 and r.json()["code"] == "plan_feature"
