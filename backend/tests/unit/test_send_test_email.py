"""`python -m app.cli send-test-email --to <address>` (S10-6): one message with a sample QR code inline
through the configured provider, the result or the classified error on the console, never a credential.
The command needs no database: every settings object here names one that does not exist."""

import json
import secrets
import ssl
from collections.abc import Iterator
from pathlib import Path

import pytest

from app import cli
from app.core.config import Settings
from app.core.qr import qr_matrix
from app.email.service import LOGO_CONTENT_ID, QR_CONTENT_ID, TEST_EMAIL_SAMPLE_FRAGMENT, brand_logo
from tests.qr_png import qr_modules
from tests.smtp_support import (
    HOST,
    Certificate,
    Credentials,
    SmtpTestServer,
    closed_port,
    make_certificate,
    smtp_server,
)

USERNAME = "visitors@demo.test"
PASSWORD = "Cli-Secret-App-Pass"
RECIPIENT = "desk@example.com"


@pytest.fixture(scope="module")
def certificate(tmp_path_factory: pytest.TempPathFactory) -> Certificate:
    return make_certificate(tmp_path_factory.mktemp("cli-smtp-certificate"))


@pytest.fixture(scope="module")
def starttls(certificate: Certificate) -> Iterator[SmtpTestServer]:
    with smtp_server(
        security="starttls", certificate=certificate, credentials=Credentials(USERNAME, PASSWORD)
    ) as server:
        yield server


@pytest.fixture
def trusted(certificate: Certificate, monkeypatch: pytest.MonkeyPatch) -> None:
    """The provider's `ssl.create_default_context()` trusts the test certificate (the system's
    certificates do not)."""
    context = certificate.client_context()
    monkeypatch.setattr(ssl, "create_default_context", lambda *args, **kwargs: context)


def _settings(**values: object) -> Settings:
    base: dict[str, object] = {
        "app_env": "development",
        "database_url": "postgresql://nobody:nothing@db.invalid/none",
        "app_base_url": "https://vms.test",
        "email_from": "Demo Visitors <visitors@demo.test>",
        "email_provider": "smtp",
        "smtp_host": HOST,
    }
    return Settings(_env_file=None, **{**base, **values})  # type: ignore[call-arg]


def _run(
    settings: Settings, capsys: pytest.CaptureFixture[str], to: str = RECIPIENT, *options: str
) -> tuple[int, str, str]:
    status = cli.main(["send-test-email", "--to", to, *options], settings=settings)
    captured = capsys.readouterr()
    return status, captured.out, captured.err


def test_a_test_email_reaches_a_local_capture_server(capsys: pytest.CaptureFixture[str]) -> None:
    with smtp_server(security="none") as capture:
        settings = _settings(smtp_port=capture.port, smtp_security="none")
        status, out, err = _run(settings, capsys)

        assert status == 0 and err == ""
        assert f"test e-mail to {RECIPIENT} accepted by the mail server {HOST}:{capture.port} (none)" in out
        [received] = capture.handler.received
        assert received.rcpt_tos == [RECIPIENT] and received.mail_from == "visitors@demo.test"
        message = received.message()
        # Arabic leads by default (B10-9): the subject is in Arabic only, like every staff message's.
        assert message["Subject"] == "رسالة تجريبية من Demo Visitors"
        assert f"message id: {message['Message-ID'].strip('<>')}" in out
        # The sample QR code is inline like an invitation's pass, and opens the pass address of QR_BASE_URL.
        sample_url = f"https://vms.test/pass#{TEST_EMAIL_SAMPLE_FRAGMENT}"
        assert f"its sample QR code opens {sample_url}" in out
        text, related = message.iter_parts()
        html, image, logo = related.iter_parts()
        assert image["Content-ID"] == f"<{QR_CONTENT_ID}>"
        assert f'src="cid:{QR_CONTENT_ID}"' in html.get_content()
        assert qr_modules(image.get_content()) == qr_matrix(sample_url)
        # The brand logo, inline like in every message.
        assert logo["Content-ID"] == f"<{LOGO_CONTENT_ID}>" and logo.get_content() == brand_logo().content
        assert f'src="cid:{LOGO_CONTENT_ID}"' in html.get_content()
        # Both languages, Arabic first; no trace of the old product name.
        body = text.get_content()
        assert body.index("إعدادات البريد الإلكتروني تعمل") < body.index("Your e-mail settings work")
        assert "visitor management" not in (body + html.get_content()).lower()


def test_the_test_email_can_lead_in_english(capsys: pytest.CaptureFixture[str]) -> None:
    with smtp_server(security="none") as capture:
        settings = _settings(smtp_port=capture.port, smtp_security="none")
        status, _out, err = _run(settings, capsys, RECIPIENT, "--language", "en")
        assert status == 0 and err == ""
        message = capture.handler.received[0].message()
        assert message["Subject"] == "Test e-mail from Demo Visitors"
        text, _related = message.iter_parts()
        body = text.get_content()
        assert body.index("Your e-mail settings work") < body.index("إعدادات البريد الإلكتروني تعمل")


def test_an_unknown_language_is_a_usage_error(capsys: pytest.CaptureFixture[str]) -> None:
    with pytest.raises(SystemExit) as stopped:
        cli.main(["send-test-email", "--to", RECIPIENT, "--language", "fr"], settings=_settings())
    assert stopped.value.code == 2
    assert "invalid choice: 'fr'" in capsys.readouterr().err


@pytest.mark.usefixtures("trusted")
@pytest.mark.parametrize("environment", ["development", "production"])
def test_starttls_with_sign_in_in_every_environment(
    starttls: SmtpTestServer, capsys: pytest.CaptureFixture[str], environment: str
) -> None:
    starttls.handler.reset()
    production = {
        "app_env": "production",
        "secret_key": secrets.token_urlsafe(48),  # generated: no production-valid key in the repository
        "database_url": "postgresql://nobody:nothing@db.invalid/none?sslmode=verify-full",
        "app_base_url": "https://vms.example.com",
        "allowed_origins": "https://vms.example.com",
    }
    settings = _settings(
        smtp_port=starttls.port,
        smtp_username=USERNAME,
        smtp_password=PASSWORD,
        **(production if environment == "production" else {}),
    )
    status, out, err = _run(settings, capsys)
    assert status == 0, err
    assert f"accepted by the mail server {HOST}:{starttls.port} (starttls)" in out
    assert len(starttls.handler.received) == 1
    assert PASSWORD not in out + err


@pytest.mark.usefixtures("trusted")
def test_a_refused_sign_in_is_printed_classified_and_without_the_password(
    starttls: SmtpTestServer, capsys: pytest.CaptureFixture[str]
) -> None:
    starttls.handler.reset()
    wrong = "Wrong-App-Pass-4567"
    settings = _settings(smtp_port=starttls.port, smtp_username=USERNAME, smtp_password=wrong)
    status, out, err = _run(settings, capsys)

    assert status == cli.EXIT_USAGE and out == ""
    assert err.strip().endswith(
        "error: test e-mail not sent (permanent): The mail server refused the SMTP sign-in (SMTP 535 5.7.8); "
        "check SMTP_USERNAME and SMTP_PASSWORD."
    )
    assert wrong not in err and "Traceback" not in err
    assert starttls.handler.received == []


def test_an_unreachable_server_is_a_temporary_failure(capsys: pytest.CaptureFixture[str]) -> None:
    settings = _settings(smtp_port=closed_port(), smtp_security="none")
    status, _out, err = _run(settings, capsys)
    assert status == cli.EXIT_USAGE
    assert (
        "error: test e-mail not sent (temporary: a real message would be retried): Could not connect" in err
    )


def test_an_invalid_address_is_refused_before_anything_is_sent(capsys: pytest.CaptureFixture[str]) -> None:
    settings = _settings(smtp_port=closed_port(), smtp_security="none")
    status, _out, err = _run(settings, capsys, to="not-an-address")
    assert status == cli.EXIT_USAGE and "error: --to: Enter a valid email address." in err
    assert "test e-mail not sent" not in err


def test_configuration_warnings_are_printed(capsys: pytest.CaptureFixture[str]) -> None:
    with smtp_server(security="none") as capture:
        settings = _settings(
            smtp_port=capture.port, smtp_security="none", app_base_url="http://localhost:5173"
        )
        status, _out, err = _run(settings, capsys)
    assert status == 0
    assert "warning: QR_BASE_URL (APP_BASE_URL when it is not set) points to this computer" in err


def test_the_outbox_provider_writes_the_test_email(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    settings = _settings(email_provider="outbox", email_outbox_dir=str(tmp_path))
    status, out, err = _run(settings, capsys)
    assert status == 0 and err == ""
    assert f"test e-mail written to {tmp_path} (EMAIL_PROVIDER=outbox sends nothing)" in out
    [metadata] = [json.loads(path.read_text(encoding="utf-8")) for path in tmp_path.glob("*.json")]
    assert metadata["to"] == RECIPIENT and metadata["subject"] == "رسالة تجريبية من Demo Visitors"
    assert metadata["pass_url"] is None  # a sample, not a pass
    assert (tmp_path / f"{metadata['message_id']}-{QR_CONTENT_ID}.png").is_file()
    logo = tmp_path / f"{metadata['message_id']}-{LOGO_CONTENT_ID}.png"
    assert logo.read_bytes() == brand_logo().content
