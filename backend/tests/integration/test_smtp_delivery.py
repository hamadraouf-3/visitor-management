"""Invitations through the SMTP provider to a real SMTP server (S10-7): the API books the visit, the
dispatcher delivers after the commit in its own slots, and the `email_messages` row, the visit's
invitation status and the audit trail follow what the server answered: accepted, rejected, deferred, or
nothing at all until the message's deadline."""

import logging
import time
from collections.abc import Iterator
from datetime import timedelta
from uuid import UUID

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import SecretStr
from sqlalchemy import Engine, select
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.core.qr import qr_matrix
from app.email.dispatcher import EmailDispatcher
from app.email.logos import light_rendition
from app.email.providers.memory import MemoryProvider
from app.email.providers.smtp import SmtpProvider, SmtpServer
from app.email.rendering import EmailRenderer
from app.email.service import LOGO_CONTENT_ID, QR_CONTENT_ID, EmailService
from app.main import create_app
from app.models import BrandAssetKind, EmailMessage, EmailStatus
from app.security.passwords import PasswordHasherService
from tests.conftest import TEST_START
from tests.png_support import SAMPLE_LOGO
from tests.qr_png import qr_modules
from tests.smtp_support import (
    HOST,
    Certificate,
    Credentials,
    RawServer,
    SmtpTestServer,
    make_certificate,
    smtp_server,
)
from tests.support import (
    TEST_CLIENT_ADDRESS,
    Api,
    Factory,
    World,
    audit_rows,
    create_visit,
    refreshed,
    signed_in,
)

START = TEST_START + timedelta(hours=2)  # 11:00 in Asia/Amman
USERNAME = "visitors@demo.test"
PASSWORD = "Integration-App-Pass"


@pytest.fixture(scope="module")
def certificate(tmp_path_factory: pytest.TempPathFactory) -> Certificate:
    return make_certificate(tmp_path_factory.mktemp("integration-smtp-certificate"))


@pytest.fixture(scope="module")
def mail_server(certificate: Certificate) -> Iterator[SmtpTestServer]:
    with smtp_server(
        security="starttls", certificate=certificate, credentials=Credentials(USERNAME, PASSWORD)
    ) as server:
        yield server


@pytest.fixture(scope="module")
def smtp_sleeps() -> list[float]:
    return []


@pytest.fixture(scope="module")
def smtp_app(
    settings: Settings,
    app_engine: Engine,
    hasher: PasswordHasherService,
    certificate: Certificate,
    mail_server: SmtpTestServer,
    smtp_sleeps: list[float],
) -> FastAPI:
    """The application as `create_app` builds it, with the SMTP provider instead of the memory one."""
    provider = SmtpProvider(
        SmtpServer(
            host=HOST,
            port=mail_server.port,
            username=USERNAME,
            password=SecretStr(PASSWORD),
            timeout_seconds=5.0,
        ),
        ehlo_name="vms.test",
        ssl_context=certificate.client_context(),
    )
    return create_app(
        settings,
        engine=app_engine,
        password_hasher=hasher,
        email_provider=provider,
        email_sleep=smtp_sleeps.append,
    )


@pytest.fixture
def host(
    smtp_app: FastAPI, connection: object, world: World, mail_server: SmtpTestServer, smtp_sleeps: list[float]
) -> Api:
    smtp_app.state.service_environment.limiter.reset()
    smtp_app.state.security_audit.reset()
    mail_server.handler.reset()
    smtp_sleeps.clear()

    def client() -> TestClient:
        return TestClient(smtp_app, base_url="https://testserver", client=TEST_CLIENT_ADDRESS)

    return signed_in(client, world.a.employee)


def _invitation(db: Session, visit_id: str) -> EmailMessage:
    db.expire_all()
    return db.scalars(select(EmailMessage).where(EmailMessage.visit_id == UUID(visit_id))).one()


def test_an_invitation_reaches_the_mail_server_with_its_pass_inline(
    host: Api, world: World, db: Session, mail_server: SmtpTestServer, factory: Factory
) -> None:
    factory.brand(world.a.company, color="#7c3aed", images={BrandAssetKind.LOGO: SAMPLE_LOGO})
    result = create_visit(
        host,
        world.a.employee.id,
        START,
        send_invitation=True,
        visitor={"full_name": "Dana Guest", "email": "Dana.Guest@Example.com"},
    )

    [received] = mail_server.handler.received
    assert received.rcpt_tos == ["dana.guest@example.com"]
    message = received.message()
    assert message["Subject"].startswith("Your visit to ")
    # Sent in the company's name, from the configured address (B12-13).
    assert message["From"] == "Alpha <no-reply@localhost>" and received.mail_from == "no-reply@localhost"
    _text, related = message.iter_parts()
    html, image, logo = related.iter_parts()
    assert image["Content-ID"] == f"<{QR_CONTENT_ID}>" and f'src="cid:{QR_CONTENT_ID}"' in html.get_content()
    # The company's own logo travels inline beside the QR code (B10-6, B12-12), as its opaque rendition
    # (B13-2), and its colour is the e-mail's.
    assert logo["Content-ID"] == f"<{LOGO_CONTENT_ID}>"
    assert logo.get_content() == light_rendition(SAMPLE_LOGO).content
    assert f'src="cid:{LOGO_CONTENT_ID}"' in html.get_content() and "#7C3AED" in html.get_content()
    # The QR code the visitor receives opens exactly the pass the API issued.
    assert qr_modules(image.get_content()) == qr_matrix(result["pass_url"])

    row = _invitation(db, result["visit"]["id"])
    assert (row.status, row.provider, row.attempts, row.last_error) == ("SENT", "smtp", 1, None)
    assert row.provider_message_id == f"vms-email-{row.id}@localhost"  # EMAIL_FROM's domain
    assert message["Message-ID"] == f"<{row.provider_message_id}>"
    assert host.get(f"/visits/{result['visit']['id']}").json()["invitation"]["status"] == "SENT"
    [sent] = audit_rows(db, "INVITATION_SENT", entity_id=UUID(result["visit"]["id"]))
    assert sent.meta["recipient_domain"] == "example.com" and sent.meta["attempts"] == 1


def test_a_rejected_recipient_fails_the_invitation_at_once(
    host: Api, world: World, db: Session, mail_server: SmtpTestServer, smtp_sleeps: list[float]
) -> None:
    mail_server.handler.script("RCPT", "550 5.1.1 <nobody@example.com>: Recipient address rejected")
    result = create_visit(
        host,
        world.a.employee.id,
        START,
        send_invitation=True,
        visitor={"full_name": "No Body", "email": "nobody@example.com"},
    )

    row = _invitation(db, result["visit"]["id"])
    assert (row.status, row.attempts) == ("FAILED", 1)
    assert row.last_error == "The mail server rejected the recipient address (SMTP 550 5.1.1)."
    assert smtp_sleeps == []  # permanent: no retry
    invitation = host.get(f"/visits/{result['visit']['id']}").json()["invitation"]
    assert invitation["status"] == "FAILED" and "nobody@example.com" not in invitation["error"]
    attention = host.get("/visits", params={"needs_attention": "true"}).json()
    assert result["visit"]["id"] in {item["id"] for item in attention["items"]}
    [failed] = audit_rows(db, "INVITATION_FAILED", entity_id=UUID(result["visit"]["id"]))
    assert failed.meta["attempts"] == 1
    assert mail_server.handler.received == []


def test_a_deferred_message_is_retried_and_sent(
    host: Api, world: World, db: Session, mail_server: SmtpTestServer, smtp_sleeps: list[float]
) -> None:
    mail_server.handler.script("DATA", "451 4.3.0 Error: queue file write error")
    result = create_visit(host, world.a.employee.id, START, send_invitation=True)

    row = _invitation(db, result["visit"]["id"])
    assert (row.status, row.attempts) == ("SENT", 2)
    assert smtp_sleeps == [1.0]
    assert len(mail_server.handler.received) == 1


def test_a_silent_mail_server_ends_the_delivery_at_its_deadline(
    db: Session, world: World, settings: Settings
) -> None:
    """SMTP_TIMEOUT_SECONDS is 10 s; the dispatcher's deadline (1.5 s here, 20 s in production) ends the
    message, after one attempt, and it shows as failed."""
    with RawServer(greeting=None) as silent:
        provider = SmtpProvider(
            SmtpServer(host=HOST, port=silent.port, security="none", timeout_seconds=10.0)
        )
        job = EmailService(
            db, settings=settings, renderer=EmailRenderer(), provider_name=provider.name
        ).queue_password_reset(world.a.employee, "t" * 43)
        db.commit()
        sleeps: list[float] = []
        started = time.monotonic()
        status = EmailDispatcher(provider, sleep=sleeps.append, deadline_seconds=1.5).deliver(job)
        elapsed = time.monotonic() - started

    assert status == EmailStatus.FAILED and sleeps == []
    assert 1.4 <= elapsed < 4.0
    row = refreshed(db, EmailMessage, job.message_id)
    assert (row.status, row.attempts) == ("FAILED", 1)
    assert row.last_error == "The mail server did not respond in time."


def test_startup_warns_about_a_gmail_sender_that_is_not_the_account(
    settings: Settings, app_engine: Engine, hasher: PasswordHasherService, caplog: pytest.LogCaptureFixture
) -> None:
    gmail = settings.model_copy(
        update={
            "email_provider": "smtp",
            "smtp_host": "smtp.gmail.com",
            "smtp_username": "visitors.desk@gmail.com",
            "smtp_password": SecretStr("abcdefghijklmnop"),
            "email_from": "Mawdoo3 <no-reply@company.example>",
        }
    )
    with caplog.at_level(logging.WARNING, logger="app.main"):
        create_app(gmail, engine=app_engine, password_hasher=hasher, email_provider=MemoryProvider())
    [record] = [
        r for r in caplog.records if r.name == "app.main" and "e-mail configuration" in r.getMessage()
    ]
    assert record.levelno == logging.WARNING
    assert "EMAIL_FROM's address is not SMTP_USERNAME" in record.getMessage()
    assert "company.example" not in record.getMessage() and "abcdefghijklmnop" not in record.getMessage()
