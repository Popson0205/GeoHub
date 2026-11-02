import json

import httpx
import pytest

from app import mailer
from app.config import settings


@pytest.fixture
def resend(monkeypatch):
    calls = []
    replies = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return replies.pop(0) if replies else httpx.Response(200, json={"id": "email_123"})
    monkeypatch.setattr(settings, "resend_api_key", "re_test_key")
    monkeypatch.setattr(settings, "mail_from", "Geohub <no-reply@geohub.example.com>")
    monkeypatch.setattr(settings, "mail_reply_to", "support@geohub.example.com")
    monkeypatch.setattr(mailer, "transport", httpx.MockTransport(handler))
    monkeypatch.setattr(mailer.asyncio, "sleep", lambda s: _noop())
    return calls, replies


async def _noop():
    return None


def test_resend_is_used_when_its_key_is_set(resend):
    import anyio
    calls, _ = resend
    ok = anyio.run(lambda: mailer.send_email("ada@example.com", "Join Acme on Geohub", "Bola invited you.\n\nSee you there.",
                                             action=("Create your account", "https://app.example.com/login?signup=1"), key="org-invite/1"))
    assert ok and len(calls) == 1
    r = calls[0]
    body = json.loads(r.content)
    assert str(r.url) == "https://api.resend.com/emails" and r.headers["authorization"] == "Bearer re_test_key"
    assert r.headers["idempotency-key"] == "org-invite/1"
    assert body["from"] == "Geohub <no-reply@geohub.example.com>" and body["to"] == ["ada@example.com"]
    assert body["reply_to"] == "support@geohub.example.com"
    assert "Create your account: https://app.example.com/login?signup=1" in body["text"]
    assert 'href="https://app.example.com/login?signup=1"' in body["html"] and "Bola invited you." in body["html"]


def test_html_is_escaped(resend):
    html = mailer.render_html("<b>x</b>", "Name: <script>alert(1)</script>", ("Go", 'https://x.example.com/?a="b"'))
    assert "<script>" not in html and "&lt;script&gt;" in html and "&lt;b&gt;x&lt;/b&gt;" in html and '"b"' not in html


def test_busy_provider_is_retried_and_a_refusal_never_breaks_the_caller(resend):
    import anyio
    calls, replies = resend
    replies += [httpx.Response(429, json={"message": "slow down"}), httpx.Response(200, json={"id": "e2"})]
    assert anyio.run(lambda: mailer.send_email("a@example.com", "s", "b")) and len(calls) == 2
    replies += [httpx.Response(403, json={"message": "The domain is not verified"})]
    assert anyio.run(lambda: mailer.send_email("a@example.com", "s", "b")) is False      # logged, not raised
    with pytest.raises(RuntimeError, match="not verified"):
        replies.append(httpx.Response(403, json={"message": "The domain is not verified"}))
        anyio.run(lambda: mailer.send_email("a@example.com", "s", "b", raise_errors=True))


def test_without_settings_email_is_only_logged(monkeypatch):
    import anyio
    monkeypatch.setattr(settings, "resend_api_key", "")
    monkeypatch.setattr(settings, "smtp_host", "")
    assert mailer.backend() == "log"
    assert anyio.run(lambda: mailer.send_email("a@example.com", "s", "b")) is False


def test_an_organization_invitation_sends_a_signup_link(actor, resend):
    calls, _ = resend
    owner = actor("Owner")
    assert owner.post("/org/members", json={"email": "new.person+geo@example.com"}).status_code == 201
    sent = [json.loads(c.content) for c in calls]
    inv = next(s for s in sent if s["to"] == ["new.person+geo@example.com"])
    assert inv["subject"].startswith("Join ") and "signup=1&amp;email=new.person%2Bgeo%40example.com" in inv["html"] and "signup=1&email=new.person%2Bgeo%40example.com" in inv["text"]


@pytest.fixture
def brevo(monkeypatch):
    calls, replies = [], []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return replies.pop(0) if replies else httpx.Response(201, json={"messageId": "<1@smtp-relay.brevo.com>"})
    monkeypatch.setattr(settings, "brevo_api_key", "xkeysib-test")
    monkeypatch.setattr(settings, "resend_api_key", "re_also_set")
    monkeypatch.setattr(settings, "mail_from", "Geohub <idrispopoola02@gmail.com>")
    monkeypatch.setattr(settings, "mail_reply_to", "Support <help@example.com>")
    monkeypatch.setattr(mailer, "transport", httpx.MockTransport(handler))
    monkeypatch.setattr(mailer.asyncio, "sleep", lambda s: _noop())
    return calls, replies


def test_brevo_comes_first_and_gets_its_own_request_shape(brevo):
    import anyio
    calls, _ = brevo
    assert mailer.backend() == "brevo"
    ok = anyio.run(lambda: mailer.send_email("ada@example.com", "You were added to Wells", "Bola added you.",
                                             action=("Open the project", "https://app.example.com/collect/p1"), key="project-add/p1/u1"))
    assert ok and len(calls) == 1
    r = calls[0]
    body = json.loads(r.content)
    assert str(r.url) == "https://api.brevo.com/v3/smtp/email" and r.headers["api-key"] == "xkeysib-test"
    assert body["sender"] == {"name": "Geohub", "email": "idrispopoola02@gmail.com"} and body["to"] == [{"email": "ada@example.com"}]
    assert body["replyTo"] == {"email": "help@example.com"} and body["headers"] == {"X-Mailin-custom": "project-add/p1/u1"}
    assert "Open the project: https://app.example.com/collect/p1" in body["textContent"] and "Bola added you." in body["htmlContent"]


def test_brevo_retries_when_busy_and_reports_a_refusal(brevo):
    import anyio
    calls, replies = brevo
    replies += [httpx.Response(503), httpx.Response(201, json={"messageId": "<2@x>"})]
    assert anyio.run(lambda: mailer.send_email("a@example.com", "s", "b")) and len(calls) == 2
    replies.append(httpx.Response(400, json={"code": "invalid_parameter", "message": "sender is not valid"}))
    with pytest.raises(RuntimeError, match="Brevo refused.*sender is not valid"):
        anyio.run(lambda: mailer.send_email("a@example.com", "s", "b", raise_errors=True))


def test_addresses_with_and_without_names():
    assert mailer.parse_address('"Geohub Team" <hi@example.com>') == ("Geohub Team", "hi@example.com")
    assert mailer.parse_address("hi@example.com") == ("", "hi@example.com")
