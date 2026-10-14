"""Select the e-mail provider from configuration."""

from ipaddress import ip_address
from urllib.parse import urlsplit

from app.core.config import GMAIL_SMTP_HOST, ConfigurationError, Settings, email_address_of
from app.email.providers.base import EmailProvider
from app.email.providers.memory import MemoryProvider
from app.email.providers.outbox import OutboxProvider
from app.email.providers.resend import ResendProvider
from app.email.providers.smtp import SmtpProvider, SmtpServer


def create_email_provider(settings: Settings) -> EmailProvider:
    match settings.email_provider:
        case "outbox":
            return OutboxProvider(settings.email_outbox_dir, fail_domain=settings.email_fail_domain)
        case "memory":
            return MemoryProvider(fail_domain=settings.email_fail_domain)
        case "resend":
            if settings.resend_api_key is None:  # also refused by Settings validation
                raise ConfigurationError("EMAIL_PROVIDER=resend requires RESEND_API_KEY")
            return ResendProvider(settings.resend_api_key)
        case "smtp":
            if settings.smtp_host is None:  # also refused by Settings validation
                raise ConfigurationError("EMAIL_PROVIDER=smtp requires SMTP_HOST")
            server = SmtpServer(
                host=settings.smtp_host,
                port=settings.smtp_server_port,
                security=settings.smtp_security,
                username=settings.smtp_username,
                password=settings.smtp_password,
                timeout_seconds=settings.smtp_timeout_seconds,
            )
            return SmtpProvider(server, ehlo_name=ehlo_name(settings.app_base_url))
    raise ConfigurationError(f"unknown EMAIL_PROVIDER {settings.email_provider!r}")


def ehlo_name(app_base_url: str) -> str:
    """The name the SMTP client gives in EHLO: the application's public host (a name the deployment
    owns), an address literal for an IP origin, never the machine's own name (which needs a DNS lookup
    and tells the mail server about the internal network)."""
    host = urlsplit(app_base_url).hostname or "localhost"
    try:
        address = ip_address(host)
    except ValueError:
        return host
    return f"[IPv6:{address}]" if address.version == 6 else f"[{address}]"


def _is_loopback(origin: str | None) -> bool:
    host = urlsplit(origin or "").hostname or ""
    if host == "localhost" or host.endswith(".localhost"):
        return True
    try:
        return ip_address(host).is_loopback
    except ValueError:
        return False


def email_configuration_warnings(settings: Settings) -> list[str]:
    """Configurations that start but are likely to disappoint (logged at startup, printed by the CLI's
    send-test-email). They name settings, never their values."""
    warnings: list[str] = []
    if settings.email_provider == "smtp":
        sender, username = email_address_of(settings.email_from), settings.smtp_username
        if (
            settings.smtp_host == GMAIL_SMTP_HOST
            and sender is not None
            and username is not None
            and sender != username.lower()
        ):
            warnings.append(
                "EMAIL_FROM's address is not SMTP_USERNAME: Gmail sends every message from the signed-in "
                "account instead, unless EMAIL_FROM is one of that account's verified 'Send mail as' "
                "addresses"
            )
        port = settings.smtp_server_port
        if settings.smtp_security == "starttls" and port == 465:
            warnings.append(
                "SMTP_PORT=465 expects TLS from the first byte: use SMTP_SECURITY=ssl with it (with starttls "
                "every delivery waits for a greeting that never comes)"
            )
        if settings.smtp_security == "ssl" and port in (25, 587):
            warnings.append(f"SMTP_PORT={port} expects STARTTLS: use SMTP_SECURITY=starttls with it")
    if settings.email_provider in {"smtp", "resend"} and _is_loopback(settings.qr_base_url):
        warnings.append(
            "QR_BASE_URL (APP_BASE_URL when it is not set) points to this computer: the QR codes and pass "
            "links in invitations open only here, not on a visitor's phone. Set it to an address phones "
            "can reach (this computer's network address, or the public https origin)"
        )
    return warnings
