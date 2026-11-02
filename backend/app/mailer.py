"""Sending email: through Resend's HTTPS API when RESEND_API_KEY is set (works on hosts that block SMTP, such as
Railway below the Pro plan), else SMTP when SMTP_HOST is set, else the message is only written to the log (dev).

Every message goes out as plain text and as simple branded HTML with one clear button. Sending never raises:
a failed email is logged, and the action that triggered it still succeeds.
"""
import asyncio
import html
import logging
import re
import smtplib
from email.message import EmailMessage

import anyio
import httpx

from .config import settings

log = logging.getLogger("mailer")
RESEND_URL = "https://api.resend.com/emails"
# Tests replace this with a mock transport.
transport: httpx.AsyncBaseTransport | None = None


def backend() -> str:
    return "resend" if settings.resend_api_key else "smtp" if settings.smtp_host else "log"


def render_html(subject: str, body: str, action: tuple[str, str] | None) -> str:
    """The plain text as HTML: paragraphs, links made clickable, and the action as a button."""
    def para(p: str) -> str:
        t = html.escape(p).replace("\n", "<br>")
        t = re.sub(r"(https?://[^\s<]+)", r'<a href="\1" style="color:#17634c">\1</a>', t)
        return f'<p style="margin:0 0 14px">{t}</p>'
    paras = "".join(para(p) for p in body.strip().split("\n\n") if p.strip())
    button = ""
    if action:
        label, url = action
        button = (f'<p style="margin:22px 0"><a href="{html.escape(url, quote=True)}" style="display:inline-block;'
                  'background:#17634c;color:#ffffff;text-decoration:none;font-weight:600;padding:12px 20px;'
                  f'border-radius:8px">{html.escape(label)}</a></p>')
    return (
        '<!doctype html><html><body style="margin:0;padding:24px;background:#f4f5f2;'
        'font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#18201d">'
        '<div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e1e5df;border-radius:12px;padding:28px">'
        '<div style="font-weight:700;font-size:18px;color:#17634c;margin-bottom:18px">Geohub</div>'
        f'<h1 style="font-size:20px;line-height:1.3;margin:0 0 16px">{html.escape(subject)}</h1>'
        f'<div style="font-size:15px;line-height:1.55">{paras}{button}</div>'
        '</div><p style="max-width:520px;margin:14px auto 0;font-size:12px;color:#6b756f;text-align:center">'
        'You received this because someone added your email address on Geohub.</p></body></html>')


def _text(body: str, action: tuple[str, str] | None) -> str:
    return body.strip() + (f"\n\n{action[0]}: {action[1]}" if action else "") + "\n"


async def _resend(to: str, subject: str, body: str, action, key: str | None) -> None:
    payload = {"from": settings.mail_from, "to": [to], "subject": subject,
               "text": _text(body, action), "html": render_html(subject, body, action)}
    if settings.mail_reply_to:
        payload["reply_to"] = settings.mail_reply_to
    headers = {"Authorization": f"Bearer {settings.resend_api_key}"}
    if key:
        headers["Idempotency-Key"] = key[:256]       # a retry never sends the same email twice (kept 24 h)
    async with httpx.AsyncClient(timeout=15, transport=transport) as c:
        for attempt in range(3):
            r = await c.post(RESEND_URL, json=payload, headers=headers)
            if r.status_code < 400:
                log.info("email sent", extra={"ctx": {"to": to, "subject": subject, "id": r.json().get("id"), "via": "resend"}})
                return
            if r.status_code in (429, 500, 502, 503, 504) and attempt < 2:
                await asyncio.sleep(1.5 * (attempt + 1))
                continue
            raise RuntimeError(f"Resend refused the email ({r.status_code}): {r.text[:300]}")


def _smtp(to: str, subject: str, body: str, action) -> None:
    msg = EmailMessage()
    msg["From"], msg["To"], msg["Subject"] = settings.mail_from, to, subject
    if settings.mail_reply_to:
        msg["Reply-To"] = settings.mail_reply_to
    msg.set_content(_text(body, action))
    msg.add_alternative(render_html(subject, body, action), subtype="html")
    if settings.smtp_port == 465:
        with smtplib.SMTP_SSL(settings.smtp_host, 465, timeout=15) as s:
            if settings.smtp_user:
                s.login(settings.smtp_user, settings.smtp_password)
            s.send_message(msg)
        return
    with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=15) as s:
        s.starttls()
        if settings.smtp_user:
            s.login(settings.smtp_user, settings.smtp_password)
        s.send_message(msg)


async def send_email(to: str, subject: str, body: str, *, action: tuple[str, str] | None = None,
                     key: str | None = None, raise_errors: bool = False) -> bool:
    """Send one email. `action` is (button label, URL); `key` stops a retried request sending it twice.
    Returns whether it was sent. Never raises unless `raise_errors` (used by the test-email command)."""
    how = backend()
    if how == "log":
        log.info("email (not sent: no RESEND_API_KEY or SMTP_HOST)",
                 extra={"ctx": {"to": to, "subject": subject, "body": _text(body, action)}})
        return False
    try:
        if how == "resend":
            await _resend(to, subject, body, action, key)
        else:
            await anyio.to_thread.run_sync(_smtp, to, subject, body, action)
        return True
    except Exception:  # noqa: BLE001
        log.exception("failed to send email to %s via %s", to, how)
        if raise_errors:
            raise
        return False
