"""Check that email works, end to end, and say exactly what is wrong if it does not.

    python3 -m app.ops.check_email you@example.com

It checks the settings, then (with Brevo) that the API key works, that MAIL_FROM is a verified sender, sends a
test email, and asks Brevo what happened to it (delivered, blocked, bounced, and why). The same check runs from the
Organization page ("Send me a test email").
"""
import asyncio
import re
import sys
from urllib.parse import urlparse

import httpx

from .. import mailer
from ..config import settings

BREVO = "https://api.brevo.com/v3"
FREE_MAIL = ("gmail.com", "googlemail.com", "yahoo.com", "ymail.com", "outlook.com", "hotmail.com", "live.com", "icloud.com")
# What Brevo's event names mean, and how bad they are.
EVENTS = {
    "delivered": ("ok", "Delivered to the recipient's mail server. If it is not in the inbox, check the spam folder."),
    "requests": ("info", "Accepted by Brevo and on its way."),
    "deferred": ("warn", "Delayed by the recipient's server; Brevo keeps trying."),
    "softBounces": ("warn", "Temporarily refused by the recipient's server (a soft bounce)."),
    "hardBounces": ("fail", "Refused by the recipient's server (a hard bounce)."),
    "blocked": ("fail", "Blocked by Brevo before sending."),
    "invalid": ("fail", "The recipient address is invalid."),
    "error": ("fail", "Brevo could not send it."),
    "spam": ("fail", "The recipient marked it as spam."),
}


def _mask(key: str) -> str:
    return f"{key[:8]}…{key[-4:]}" if len(key) > 14 else "set"


class Report:
    def __init__(self):
        self.steps: list[dict] = []

    def add(self, status: str, name: str, detail: str):
        self.steps.append({"status": status, "name": name, "detail": detail})

    @property
    def ok(self) -> bool:
        return not any(s["status"] == "fail" for s in self.steps)

    def out(self) -> dict:
        return {"ok": self.ok, "provider": mailer.backend(), "steps": self.steps}


async def _brevo(client: httpx.AsyncClient, r: Report, to: str, wait_s: float) -> None:
    h = {"api-key": settings.brevo_api_key, "accept": "application/json"}
    _, sender = mailer.parse_address(settings.mail_from)

    # 1. the key, the account and its credits
    a = await client.get(f"{BREVO}/account", headers=h)
    if a.status_code == 401:
        text = a.text.lower()
        if "ip" in text:
            r.add("fail", "Brevo API key", "Brevo refused this server's IP address. In Brevo: Security → Authorised IPs, "
                  "allow it or turn off the IP check (Railway's IP can change). Brevo said: " + a.text[:200])
        else:
            r.add("fail", "Brevo API key", "Brevo did not accept BREVO_API_KEY. Use an API key (SMTP & API → API Keys), "
                  "not the SMTP key, and copy it whole. Brevo said: " + a.text[:200])
        return
    if a.status_code >= 400:
        r.add("fail", "Brevo API key", f"Brevo answered {a.status_code}: {a.text[:200]}")
        return
    acc = a.json()
    credits = [p for p in acc.get("plan", []) if p.get("creditsType") == "sendLimit" or p.get("type") in ("free", "payAsYouGo", "subscription")]
    left = next((p.get("credits") for p in credits if p.get("credits") is not None), None)
    r.add("ok", "Brevo API key", f"Works for the Brevo account {acc.get('email', '?')}"
          + (f" ({acc.get('companyName')})" if acc.get("companyName") else "")
          + (f". Emails left on the plan: {left}." if left is not None else "."))
    if left is not None and float(left) <= 0:
        r.add("fail", "Brevo credits", "The Brevo plan has no emails left today. Wait for the daily reset or upgrade.")
        return

    # 2. the sender
    s = await client.get(f"{BREVO}/senders", headers=h)
    if s.status_code < 400:
        senders = s.json().get("senders", [])
        match = next((x for x in senders if x.get("email", "").lower() == sender.lower()), None)
        if not match:
            listed = ", ".join(x.get("email", "") for x in senders) or "none"
            r.add("fail", "Sender", f"{sender} is not a sender in Brevo. Add it under Senders, Domains & Dedicated IPs → "
                  f"Senders, then click the link Brevo emails to it. Senders there now: {listed}.")
            return
        if not match.get("active", False):
            r.add("fail", "Sender", f"{sender} is added in Brevo but not verified yet. Open the email Brevo sent to it "
                  "and click the confirmation link (or use 'Resend verification' in Brevo).")
            return
        r.add("ok", "Sender", f"{sender} is a verified sender in Brevo.")
    else:
        r.add("warn", "Sender", f"Could not list Brevo senders ({s.status_code}); carrying on.")

    # 3. send
    payload = {"sender": {"email": sender, "name": mailer.parse_address(settings.mail_from)[0] or "Geohub"},
               "to": [{"email": to}], "subject": "Geohub email check",
               "htmlContent": mailer.render_html("Geohub email check", "This is a test from your Geohub server. If you "
                                                 "can read this, invitations will reach people.", ("Open Geohub", settings.app_url)),
               "textContent": "This is a test from your Geohub server. If you can read this, invitations will reach people.\n"}
    if settings.mail_reply_to:
        payload["replyTo"] = {"email": mailer.parse_address(settings.mail_reply_to)[1]}
    sent = await client.post(f"{BREVO}/smtp/email", headers=h, json=payload)
    if sent.status_code >= 400:
        r.add("fail", "Send", f"Brevo refused the test email ({sent.status_code}): {sent.text[:300]}")
        return
    mid = sent.json().get("messageId", "")
    r.add("ok", "Send", f"Brevo accepted the test email to {to}.")

    # 4. what happened to it
    if not mid or wait_s <= 0:
        return
    seen: list[dict] = []
    deadline = asyncio.get_running_loop().time() + wait_s
    while asyncio.get_running_loop().time() < deadline:
        await asyncio.sleep(3)
        e = await client.get(f"{BREVO}/smtp/statistics/events", headers=h, params={"messageId": mid, "limit": 20})
        if e.status_code < 400:
            seen = e.json().get("events", []) or []
            if any(ev.get("event") not in ("requests", "deferred") for ev in seen):
                break
    if not seen:
        r.add("info", "Delivery", "Brevo has not reported on it yet. Look in Brevo: Transactional → Logs, in a minute.")
        return
    order = ["blocked", "hardBounces", "invalid", "error", "spam", "softBounces", "deferred", "delivered", "requests"]
    last = sorted(seen, key=lambda ev: order.index(ev.get("event")) if ev.get("event") in order else 99)[0]
    status, meaning = EVENTS.get(last.get("event", ""), ("info", f"Brevo reports: {last.get('event')}."))
    reason = f" Reason: {last['reason']}." if last.get("reason") else ""
    hint = ""
    if last.get("event") in ("blocked", "hardBounces", "softBounces") and sender.split("@")[-1].lower() in FREE_MAIL:
        hint = (" Sending from a Gmail/Yahoo address through Brevo is often refused by Gmail and Yahoo. Verify your own "
                "domain in Brevo (Domains) and set MAIL_FROM to an address on it.")
    if last.get("event") == "blocked" and "contact" in (last.get("reason") or "").lower():
        hint += " This address may be on Brevo's blocklist: Transactional → Settings → Blocked contacts, then unblock it."
    r.add(status, "Delivery", meaning + reason + hint)


async def diagnose(to: str, wait_s: float = 20) -> dict:
    r = Report()
    how = mailer.backend()
    if how == "log":
        r.add("fail", "Email service", "No BREVO_API_KEY, RESEND_API_KEY or SMTP_HOST is set on the server, so emails are "
              "only written to the log. Add BREVO_API_KEY in Railway → Variables and let it redeploy.")
        return r.out()
    key = settings.brevo_api_key if how == "brevo" else settings.resend_api_key if how == "resend" else ""
    r.add("ok", "Email service", f"Sending through {how.capitalize()}" + (f" (key {_mask(key)})." if key else "."))

    name, sender = mailer.parse_address(settings.mail_from)
    if "@" not in sender:
        r.add("fail", "MAIL_FROM", f"MAIL_FROM is not an email address: {settings.mail_from!r}. Example: Geohub <you@example.com>")
        return r.out()
    if sender.endswith("@example.org") or sender.endswith("@example.com"):
        r.add("fail", "MAIL_FROM", f"MAIL_FROM is still the placeholder {sender}. Set it to your verified sender, "
              "e.g. Geohub <idrispopoola02@gmail.com>.")
        return r.out()
    free = sender.split("@")[-1].lower() in FREE_MAIL
    r.add("warn" if free else "ok", "MAIL_FROM", f"Emails come from {settings.mail_from}."
          + (" Fine for testing, but Gmail and Yahoo often filter mail sent from a free address by another service: "
             "use your own domain before inviting clients." if free else ""))
    host = urlparse(settings.app_url).hostname or ""
    if host in ("localhost", "127.0.0.1", "") or not settings.app_url.startswith("https://"):
        r.add("warn", "APP_URL", f"APP_URL is {settings.app_url!r}; buttons in emails link there. Set it to your app's "
              "public https address.")
    if not re.match(r"[^@\s]+@[^@\s]+\.[^@\s]+$", to):
        r.add("fail", "Recipient", f"{to!r} is not an email address.")
        return r.out()

    if how == "brevo":
        async with httpx.AsyncClient(timeout=20, transport=mailer.transport) as client:
            try:
                await _brevo(client, r, to, wait_s)
            except httpx.HTTPError as e:
                r.add("fail", "Brevo", f"Could not reach Brevo from the server: {e}")
        return r.out()
    try:
        await mailer.send_email(to, "Geohub email check", "This is a test from your Geohub server.",
                                action=("Open Geohub", settings.app_url), raise_errors=True)
        r.add("ok", "Send", f"Sent to {to} through {how}. Check the inbox and the spam folder.")
    except Exception as e:  # noqa: BLE001
        r.add("fail", "Send", str(e)[:400])
    return r.out()


ICON = {"ok": "OK  ", "warn": "WARN", "fail": "FAIL", "info": "INFO"}

if __name__ == "__main__":
    from .. import logging_setup
    logging_setup.setup()
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(2)
    out = asyncio.run(diagnose(sys.argv[1]))
    for st in out["steps"]:
        print(f"[{ICON[st['status']]}] {st['name']}: {st['detail']}")
    print("\nEmail works." if out["ok"] else "\nEmail is not working yet: fix the FAIL line above and run this again.")
    sys.exit(0 if out["ok"] else 1)
