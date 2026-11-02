"""Send one test email to check the email settings.   python -m app.ops.test_email you@example.com

On Railway: open the service, then "Run a command" (or `railway run`) with the line above. It prints which way
email goes (Resend, SMTP, or only the log), and the provider's error in full if it fails."""
import sys

import anyio

from .. import logging_setup, mailer
from ..config import settings


async def main(to: str) -> int:
    how = mailer.backend()
    print(f"Sending through: {how}   From: {settings.mail_from}")
    if how == "log":
        print("No BREVO_API_KEY, RESEND_API_KEY or SMTP_HOST is set, so emails are only written to the log. Set BREVO_API_KEY.")
        return 1
    try:
        await mailer.send_email(to, "Geohub email is working",
                                "This is a test from your Geohub server. If you can read this, invitations and "
                                "notifications will reach people.", action=("Open Geohub", settings.app_url), raise_errors=True)
    except Exception as e:  # noqa: BLE001
        print(f"FAILED: {e}")
        msg = str(e).lower()
        if how == "brevo" and ("sender" in msg or "not valid" in msg or "400" in msg):
            print("Check that the MAIL_FROM address is a verified sender in Brevo (Senders, Domains & Dedicated IPs).")
        elif how == "brevo" and ("401" in msg or "key" in msg or "unauthorized" in msg or "ip" in msg):
            print("Check BREVO_API_KEY (an API key, not the SMTP key). If Brevo blocks unknown IP addresses, allow the "
                  "server's IP or turn that check off under Security > Authorised IPs.")
        elif "domain" in msg or "403" in msg:
            print("Check that MAIL_FROM uses a domain you verified in Resend (Domains page), e.g. "
                  "'Geohub <no-reply@yourdomain.com>'.")
        return 1
    print(f"Sent to {to}. Check the inbox (and spam folder).")
    return 0


if __name__ == "__main__":
    logging_setup.setup()
    if len(sys.argv) != 2 or "@" not in sys.argv[1]:
        print(__doc__)
        sys.exit(2)
    sys.exit(anyio.run(main, sys.argv[1]))
