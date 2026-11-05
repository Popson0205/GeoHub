"""A minimal GeoEstate app that signs people in with Geohub: a template for Land Registry, LandCheck and FarmScan.

    pip install fastapi uvicorn httpx "PyJWT[crypto]"
    GEOHUB_URL=https://hub.example GEOHUB_API=https://hub.example/api APP_URL=http://localhost:8090 \
    GEOESTATE_ID_CLIENT=land GEOESTATE_ID_SECRET=… uvicorn example_app:app --port 8090

Register it in Geohub's ID_CLIENTS with redirect_uris ["http://localhost:8090/auth/callback"].
Tokens are kept in http-only cookies here for brevity; a real app keeps the refresh token server-side."""
import html
import os
import time
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

from geoestate_id import GeoEstateID, GeoEstateIDError

APP_URL = os.environ.get("APP_URL", "http://localhost:8090").rstrip("/")
CALLBACK = f"{APP_URL}/auth/callback"
gid = GeoEstateID(geohub=os.environ["GEOHUB_URL"], api=os.environ["GEOHUB_API"], client_id=os.environ.get("GEOESTATE_ID_CLIENT", "land"),
                  client_secret=os.environ.get("GEOESTATE_ID_SECRET") or None)
app = FastAPI(title="Example GeoEstate app")
app.mount("/ui", StaticFiles(directory=Path(__file__).resolve().parent.parent / "ui"), name="ui")   # the GeoEstate UI kit
SECURE = APP_URL.startswith("https://")
APP_NAME = os.environ.get("APP_NAME", "Land Registry")
WHAT = {"hub": "Field data, maps and dashboards", "land": "Parcels, titles and transfers", "check": "Location and due-diligence reports",
        "farm": "Crop monitoring from satellite and drone"}
e = html.escape


def bar(me: dict | None = None, apps: list[dict] | None = None) -> str:
    """The GeoEstate top bar (ui/react/GeoEstateBar.tsx, server-rendered): logo, app name, app switcher, who is signed in."""
    switcher = ""
    if me and apps and len(apps) > 1:
        items = "".join(
            f"<{'a href=' + chr(39) + e(a['url']) + chr(39) if a['url'] and not a['current'] else 'div'} class='ge-app ge-app-{e(a['product'])}"
            f"{' is-here' if a['current'] else '' if a['url'] else ' is-off'}'><span class=ge-app-tile>{e(a['name'][0])}</span>"
            f"<span class=ge-app-text><strong>{e(a['name'])}</strong><span>{'You are here' if a['current'] else e(WHAT.get(a['product'], ''))}</span></span>"
            f"</{'a' if a['url'] and not a['current'] else 'div'}>" for a in apps)
        switcher = ("<details class=ge-apps><summary class=ge-apps-btn aria-label='GeoEstate apps'><svg width=20 height=20 viewBox='0 0 24 24'>"
                    + "".join(f"<circle cx={x} cy={y} r=1.8 fill=currentColor />" for y in (5.5, 12, 18.5) for x in (5.5, 12, 18.5))
                    + "</svg></summary><div class=ge-apps-pop><div class=ge-apps-head><strong>GeoEstate apps</strong>"
                    f"<span>One sign-in for all of them</span></div>{items}</div></details>")
    who = (f"<div class=ge-who>{e(me['name'])}<span>{e((me.get('org') or {}).get('name') or 'GeoEstate staff')}</span></div>"
           "<form method=post action=/auth/sign-out><button class='ge-btn ge-btn-ghost ge-btn-sm'>Sign out</button></form>") if me else ""
    return (f"<header class=ge-bar><a class=ge-brand href=/><img src=/ui/geoestate-logo.png alt=GeoEstate>"
            f"<span>GeoEstate <strong>{e(APP_NAME)}</strong></span></a><span class=ge-spacer></span>{switcher}{who}</header>")


def page(body: str, me: dict | None = None, apps: list[dict] | None = None) -> HTMLResponse:
    return HTMLResponse(f"<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'>"
                        f"<title>{e(APP_NAME)} · GeoEstate</title><link rel=stylesheet href=/ui/geoestate.css>"
                        "<style>details.ge-apps>summary{list-style:none}details.ge-apps>summary::-webkit-details-marker{display:none}</style>"
                        f"<body class=ge-page>{bar(me, apps)}<main class=ge-main>{body}</main></body>")


@app.get("/")
def home(request: Request):
    token = request.cookies.get("at")
    if token:
        try:
            me = gid.verify(token)
        except GeoEstateIDError:
            if request.cookies.get("rt"):
                return RedirectResponse("/auth/refresh")
            me = None
        if me:
            p = me.get("product") or {}
            try:
                apps = gid.apps(token)
            except GeoEstateIDError:
                apps = []
            status = {"active": "ge-badge-ok", "demo": "ge-badge-info", "grace": "ge-badge-warn"}.get(p.get("status", ""), "ge-badge-bad")
            return page(f"<h1>Hello, {e(me['name'])}</h1>"
                        "<section class=ge-card><h2>Your organization</h2>"
                        f"<p><strong>{e((me.get('org') or {}).get('name', 'GeoEstate staff'))}</strong> "
                        f"<span class=ge-muted>· {e((me.get('org') or {}).get('role', me.get('staff_role') or ''))}</span></p>"
                        f"<p>Licence: <strong id=plan>{e(p.get('plan_name', 'staff access'))}</strong> "
                        f"<span id=status class='ge-badge {status}'>{e(p.get('status_name', me.get('staff_role') or ''))}</span>"
                        f"<span class=ge-muted> · {'can change things' if gid.can_write(me) else 'read-only'}</span></p>"
                        f"<p class=ge-small>Features: {e(', '.join(p.get('features', [])) or 'none')}</p></section>"
                        "<p class=ge-muted>This is the example app from Geohub's clients/ folder: the starting point for each new GeoEstate app.</p>",
                        me, apps)
    return page(f"<section class=ge-card><h1>{e(APP_NAME)}</h1><p class=ge-muted>Sign in with the account you use for Geohub.</p>"
                "<p><a id=signin class='ge-btn ge-btn-primary' href=/auth/sign-in>Sign in with GeoEstate</a></p></section>")


@app.get("/auth/sign-in")
def sign_in():
    verifier, state = gid.new_verifier(), gid.new_state()
    r = RedirectResponse(gid.authorize_url(CALLBACK, state, verifier))
    for k, v in (("pkce", verifier), ("state", state)):
        r.set_cookie(k, v, max_age=600, httponly=True, secure=SECURE, samesite="lax")
    return r


def _keep(r, tokens: dict):
    r.set_cookie("at", tokens["access_token"], max_age=tokens["expires_in"], httponly=True, secure=SECURE, samesite="lax")
    r.set_cookie("rt", tokens["refresh_token"], max_age=30 * 86400, httponly=True, secure=SECURE, samesite="lax")
    return r


@app.get("/auth/callback")
def callback(request: Request, code: str = "", state: str = ""):
    if not code or state != request.cookies.get("state"):
        return page("<h1>Sign-in did not start here</h1><p><a href=/auth/sign-in>Sign in again</a></p>")
    try:
        tokens = gid.exchange(code, CALLBACK, request.cookies.get("pkce", ""))
    except GeoEstateIDError as e:
        return page(f"<h1>Sign-in failed</h1><p>{html.escape(str(e))}</p>")
    r = _keep(RedirectResponse("/"), tokens)
    r.delete_cookie("pkce"); r.delete_cookie("state")
    return r


@app.get("/auth/refresh")
def refresh(request: Request):
    try:
        return _keep(RedirectResponse("/"), gid.refresh(request.cookies.get("rt", "")))
    except GeoEstateIDError as e:
        r = page(f"<h1>Signed out</h1><p>{html.escape(str(e))}</p><p><a href=/auth/sign-in>Sign in again</a></p>")
        r.delete_cookie("at"); r.delete_cookie("rt")
        return r


@app.post("/auth/sign-out")
def sign_out(request: Request):
    if request.cookies.get("rt"):
        try:
            gid.sign_out(request.cookies["rt"])
        except GeoEstateIDError:
            pass
    r = RedirectResponse("/", status_code=303)
    r.delete_cookie("at"); r.delete_cookie("rt")
    return r


@app.get("/health")
def health():
    return {"ok": True, "at": int(time.time())}
