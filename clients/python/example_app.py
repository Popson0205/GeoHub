"""A minimal GeoEstate app that signs people in with Geohub: a template for Land Registry, LandCheck and FarmScan.

    pip install fastapi uvicorn httpx "PyJWT[crypto]"
    GEOHUB_URL=https://hub.example GEOHUB_API=https://hub.example/api APP_URL=http://localhost:8090 \
    GEOESTATE_ID_CLIENT=land GEOESTATE_ID_SECRET=… uvicorn example_app:app --port 8090

Register it in Geohub's ID_CLIENTS with redirect_uris ["http://localhost:8090/auth/callback"].
Tokens are kept in http-only cookies here for brevity; a real app keeps the refresh token server-side."""
import html
import os
import time

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, RedirectResponse

from geoestate_id import GeoEstateID, GeoEstateIDError

APP_URL = os.environ.get("APP_URL", "http://localhost:8090").rstrip("/")
CALLBACK = f"{APP_URL}/auth/callback"
gid = GeoEstateID(geohub=os.environ["GEOHUB_URL"], api=os.environ["GEOHUB_API"], client_id=os.environ.get("GEOESTATE_ID_CLIENT", "land"),
                  client_secret=os.environ.get("GEOESTATE_ID_SECRET") or None)
app = FastAPI(title="Example GeoEstate app")
SECURE = APP_URL.startswith("https://")


def page(body: str) -> HTMLResponse:
    return HTMLResponse(f"<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width'><title>Example app</title>"
                        "<body style='font:16px system-ui;max-width:640px;margin:40px auto;padding:0 16px;color:#1a2233'>"
                        f"{body}</body>")


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
            return page(f"<h1>Hello, {html.escape(me['name'])}</h1>"
                        f"<p>Organization: <b>{html.escape((me.get('org') or {}).get('name', 'none'))}</b> "
                        f"({html.escape((me.get('org') or {}).get('role', ''))})</p>"
                        f"<p>Licence: <b id=plan>{html.escape(p.get('plan_name', 'staff access'))}</b>, "
                        f"<span id=status>{html.escape(p.get('status_name', me.get('staff_role') or ''))}</span>"
                        f"{' · can change things' if gid.can_write(me) else ' · read-only'}</p>"
                        f"<p>Features: {html.escape(', '.join(p.get('features', [])) or 'none')}</p>"
                        "<form method=post action=/auth/sign-out><button>Sign out</button></form>")
    return page("<h1>Example GeoEstate app</h1><p><a id=signin href=/auth/sign-in>Sign in with GeoEstate</a></p>")


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
