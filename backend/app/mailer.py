import logging
import smtplib
from email.message import EmailMessage

import anyio

from .config import settings

log = logging.getLogger("mailer")


def _send(to: str, subject: str, body: str):
    msg = EmailMessage()
    msg["From"], msg["To"], msg["Subject"] = settings.mail_from, to, subject
    msg.set_content(body)
    with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=15) as s:
        s.starttls()
        if settings.smtp_user:
            s.login(settings.smtp_user, settings.smtp_password)
        s.send_message(msg)


async def send_email(to: str, subject: str, body: str):
    """SMTP when configured, otherwise the message is written to the log (dev). Never raises."""
    if not settings.smtp_host:
        log.info("email (not sent, no SMTP configured)", extra={"ctx": {"to": to, "subject": subject, "body": body}})
        return
    try:
        await anyio.to_thread.run_sync(_send, to, subject, body)
    except Exception:  # noqa: BLE001
        log.exception("failed to send email to %s", to)
