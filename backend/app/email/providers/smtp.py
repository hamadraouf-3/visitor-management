"""SMTP provider: the standard library's `smtplib` and `email` packages (S10-1; no new runtime dependency).

Like every provider, `send` is blocking: the dispatcher runs it in a worker thread holding one of its
delivery slots, never on the event loop or in a request thread (RR1-02).

Connection (S10-2). SMTP_SECURITY `starttls` (port 587) upgrades the connection with STARTTLS before
anything else is sent and fails when the server does not offer it (never a silent fallback to plain
text); `ssl` (port 465) speaks TLS from the first byte; `none` (development and tests only: local capture
servers) sends everything unencrypted and never authenticates. TLS uses `ssl.create_default_context()`:
the system's trusted certificates, the server's name checked against SMTP_HOST, TLS 1.2 or later. AUTH
uses SMTP_USERNAME and SMTP_PASSWORD (a SecretStr: never logged, never in an error message, an audit row
or a `repr`), once per message with the first of PLAIN and LOGIN the server offers (S10-12). smtplib's
protocol trace stays off (it would print the AUTH exchange).

Time (S10-3, S10-10). Every wait for the server is given `min(SMTP_TIMEOUT_SECONDS, time left)`, where
the time left is what the dispatcher has left of the message's 20 s deadline (`timeout_seconds`): the
connection to each address of SMTP_HOST, each write, each receive of a reply (not each reply: a server
may send it a line or a byte at a time) and the TLS handshakes. Once the deadline has passed the next wait
fails, so no server, however it spreads its replies out, holds an attempt past the deadline; a reply is
also at most 64 KiB. The name lookup is the system resolver's and has no timeout of its own.

Message (S10-1). An `EmailMessage` with policy SMTP:

    multipart/alternative
    ├── text/plain                    (quoted-printable)
    └── multipart/related
        ├── text/html                 (quoted-printable; <img src="cid:visitor-pass-qr">)
        └── image/png                 (base64; Content-ID: <visitor-pass-qr>; inline)

which Gmail, Outlook and Apple Mail show with the QR code inside the HTML. From, Reply-To and Subject are
the ones the Resend provider sends (`EmailService` builds them: EMAIL_FROM, the deployment's or host's
reply address, the rendered subject); this provider adds `Date` and a `Message-ID` derived from the
message's row (`<vms-email-<id>@<sender's domain>>`), so the retries of one message carry the same ID.
Every header value is passed through `sanitize_header` and set through the `email` package, which
refuses a value with a line break of any kind: no text a visitor, a host or an administrator chooses
(names, company names, the purpose) can add a header or a recipient. The package also decodes RFC 2047
encoded words (`=?utf-8?q?...?=`) in what it is given, so the subject has each `=?` broken up, to reach
the client as written (`headers.literal_text`, which the renderer applies for every provider since
B11-41), and an address holding one is never used (S10-13). The envelope names exactly the
message's one recipient. Bodies are 7-bit (quoted-printable or base64), so no server needs 8BITMIME;
an address whose local part is not ASCII needs the server's SMTPUTF8 (domains are sent in their
ASCII form).

Errors (S10-4) follow the dispatcher's model: connection failures, timeouts, TLS failures other than an
unverifiable certificate, every 4xx reply (421 included, also to EHLO: S10-11) and a dropped connection
are transient; 5xx
replies (550 or 553 for a bad recipient, 554 for a refused message) are permanent, and so are the
problems only an administrator can fix: a refused sign-in (535, 534), a server that requires sign-in
(530), no STARTTLS or AUTH, an unverifiable certificate and a refused sender. Those are also logged once
(ERROR, `SMTP configuration problem`, naming the settings to check) until a message is sent again. Error
messages name the stage, the reply code and its enhanced status code only: never the server's own text,
which can repeat the recipient's address, and never a credential.
"""

import io
import logging
import re
import smtplib
import socket
import ssl
import sys
import threading
import time
from collections.abc import Buffer, Callable
from dataclasses import dataclass, field
from datetime import datetime
from email.errors import MessageError
from email.headerregistry import Address
from email.message import EmailMessage
from email.policy import SMTP as SMTP_POLICY
from email.utils import format_datetime, parseaddr
from typing import Literal

import idna
from pydantic import SecretStr

from app.core import time as app_time
from app.core.config import SmtpSecurity
from app.email.headers import literal_text, sanitize_header
from app.email.providers.base import EmailDeliveryError, OutgoingEmail, ProviderResult
from app.email.providers.common import SAFE_CONTENT_ID

logger = logging.getLogger("app.email")

DEFAULT_TIMEOUT_SECONDS = 10.0
# The time one `send` may take when the caller gives none (the dispatcher always does): its deadline.
DEFAULT_SEND_SECONDS = 20.0
# The TLS handshake after STARTTLS gets the time left when the server's 220 has been read, and at least
# this long (a handshake is bounded as a whole by its timeout), so a reply read in time never fails.
MIN_HANDSHAKE_SECONDS = 0.05
# smtplib keeps every line of a reply in memory and reads continuation lines without limit.
MAX_REPLY_BYTES = 64 * 1024
# One AUTH per message, with the first of these the server offers (every credential goes over TLS).
AUTH_MECHANISMS = ("PLAIN", "LOGIN")
_ENHANCED_STATUS = re.compile(rb"\s*([245]\.\d{1,3}\.\d{1,3})(?:\s|$)")
_SSL_REASON = re.compile(r"[A-Z0-9_]{1,64}")
_MIME_TYPE = re.compile(r"([a-z]{1,32})/([a-z0-9.+-]{1,64})")

Stage = Literal["connect", "ehlo", "starttls", "login", "send"]
_REFUSED: dict[Stage, str] = {
    "connect": "refused the connection",
    "ehlo": "refused the greeting (EHLO)",
    "starttls": "refused STARTTLS",
    "login": "refused the SMTP sign-in",
    "send": "rejected the message",
}
_DEFERRED: dict[Stage, str] = {
    "connect": "is not accepting connections right now",
    "ehlo": "deferred the greeting (EHLO)",
    "starttls": "cannot start TLS right now",
    "login": "cannot check the SMTP sign-in right now",
    "send": "deferred the message",
}
# Problems only an administrator can fix: logged once (until a message is sent again), with what to check.
_CONFIGURATION_HINTS = {
    "credentials": (
        "the mail server refused the SMTP sign-in: check SMTP_USERNAME and SMTP_PASSWORD (for Gmail, "
        "SMTP_PASSWORD must be an App Password of the SMTP_USERNAME account, which needs 2-Step "
        "Verification; the account's own password is refused)"
    ),
    "sign-in-required": (
        "the mail server requires SMTP sign-in: set SMTP_USERNAME and SMTP_PASSWORD (with SMTP_SECURITY "
        "starttls or ssl)"
    ),
    "starttls": "the mail server does not offer STARTTLS: check SMTP_SECURITY and SMTP_PORT",
    "auth": (
        "the mail server offers no SMTP sign-in this client can use on this connection: check "
        "SMTP_SECURITY and SMTP_PORT, or leave SMTP_USERNAME and SMTP_PASSWORD empty if it needs none"
    ),
    "certificate": (
        "the mail server's TLS certificate could not be verified: check SMTP_HOST (it must be a name the "
        "certificate is issued for) and the system's trusted certificates"
    ),
    "sender": (
        "the mail server refused the sender: EMAIL_FROM must be an address the SMTP_USERNAME account may "
        "send as"
    ),
}


@dataclass(frozen=True, slots=True)
class SmtpServer:
    """Where and how to connect (SMTP_* settings)."""

    host: str
    port: int
    security: SmtpSecurity = "starttls"
    username: str | None = None
    password: SecretStr | None = field(default=None, repr=False)
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS


class _Budget:
    """The waits of one attempt: each at most the per-operation timeout, and none past the deadline."""

    def __init__(self, timeout: float, deadline: float, monotonic: Callable[[], float]) -> None:
        self._timeout = timeout
        self._deadline = deadline
        self._monotonic = monotonic

    def wait(self) -> float:
        """The timeout for the next wait: a connection to one address, one write, one receive. Raises
        TimeoutError once the deadline has passed; since every wait asks again, no number of them (lines
        or bytes spread out over time, addresses, handshakes) can stretch the attempt past the deadline."""
        left = self._deadline - self._monotonic()
        if left <= 0:
            raise TimeoutError("the delivery deadline has passed")
        return min(self._timeout, left)

    def handshake(self) -> float:
        """The timeout for a TLS handshake that follows a reply already read: the time left, never less
        than MIN_HANDSHAKE_SECONDS (raising here would turn a refusal just read into a timeout)."""
        return max(min(self._timeout, self._deadline - self._monotonic()), MIN_HANDSHAKE_SECONDS)


class _ReplyTooLong(OSError):
    """A reply longer than MAX_REPLY_BYTES."""


class _ReplyReader(io.RawIOBase):
    """What the server sends, for smtplib's `getreply`: each receive is given `budget.wait()`, and one
    reply is at most MAX_REPLY_BYTES. (smtplib reads through `socket.makefile`, whose receives each get
    the whole socket timeout again: a server that sends a line, or a byte, within every timeout was never
    timed out.) Once the deadline has passed, a receive takes only what has already arrived and never
    waits: a reply the server sent in time (a refusal, say) is still read as what it is."""

    def __init__(self, sock: socket.socket, budget: _Budget) -> None:
        super().__init__()
        self._sock = sock
        self._budget = budget
        self.reply_bytes = 0

    def readable(self) -> bool:
        return True

    def readinto(self, buffer: Buffer, /) -> int:
        if self.reply_bytes > MAX_REPLY_BYTES:
            raise _ReplyTooLong("the mail server's reply is too long")
        try:
            timeout = self._budget.wait()
        except TimeoutError:
            timeout = 0.0  # the deadline has passed: only what has already arrived
        self._sock.settimeout(timeout)
        try:
            received = self._sock.recv_into(buffer)
        except BlockingIOError, ssl.SSLWantReadError, ssl.SSLWantWriteError:
            # Only a receive that does not wait raises these: nothing more had arrived by the deadline.
            raise TimeoutError("the delivery deadline has passed") from None
        self.reply_bytes += received
        return received


class _BoundedSMTP(smtplib.SMTP):
    """`smtplib.SMTP` that never waits past the attempt's deadline (S10-3), checks every EHLO reply and
    signs in with one AUTH (S10-4).

    smtplib sets a socket timeout and lets each address of the host, each receive and each TLS handshake
    start it again. Here each of them asks `budget.wait()` instead: the connection to each address
    (`_get_socket`), each write (`send`), each receive of a reply (`_ReplyReader`), and the handshakes
    (`budget.handshake()` after the reply to STARTTLS; implicit TLS in `_BoundedSMTPSSL`). Once the
    deadline has passed the next wait raises TimeoutError. smtplib turns that, in a write or a reply, into
    SMTPServerDisconnected (with the TimeoutError as its context), and ignores SMTPServerDisconnected in
    the clean-up after a refusal (RSET), so a refusal read before the deadline is still reported as one.
    The name lookup is the system resolver's: it has no timeout of its own here."""

    budget: _Budget
    _reader: _ReplyReader | None = None

    def _get_socket(self, host: str, port: int, timeout: float) -> socket.socket:
        """`socket.create_connection`, with each address given `budget.wait()` (create_connection gives
        each one the whole timeout, so N unreachable addresses took N times SMTP_TIMEOUT_SECONDS)."""
        error: OSError | None = None
        for family, kind, protocol, _name, address in socket.getaddrinfo(host, port, 0, socket.SOCK_STREAM):
            wait = self.budget.wait()  # once the deadline has passed, no further address is tried
            sock = socket.socket(family, kind, protocol)
            try:
                sock.settimeout(wait)
                if self.source_address:
                    sock.bind(self.source_address)
                sock.connect(address)
            except OSError as exc:
                sock.close()
                error = exc  # like create_connection: the last address's error
                continue
            return sock
        raise error if error is not None else OSError("getaddrinfo returned no address")

    def send(self, s: Buffer | str) -> None:
        """smtplib's `send`, writing as much as the connection takes at a time, each write given
        `budget.wait()` (`sendall` on a TLS connection waits the whole timeout for every part)."""
        if self.sock is None:
            raise smtplib.SMTPServerDisconnected("please run connect() first")
        data = s.encode(self.command_encoding) if isinstance(s, str) else bytes(s)
        sys.audit("smtplib.send", self, data)
        try:
            with memoryview(data) as view:
                sent = 0
                while sent < len(view):
                    self.sock.settimeout(self.budget.wait())
                    sent += self.sock.send(view[sent:])
        except OSError as exc:
            self.close()
            raise smtplib.SMTPServerDisconnected("Server not connected") from exc

    def getreply(self) -> tuple[int, bytes]:
        if self.file is None and self.sock is not None:  # a new connection, or the one STARTTLS secured
            self._reader = _ReplyReader(self.sock, self.budget)
            self.file = io.BufferedReader(self._reader)
        if self._reader is not None:
            self._reader.reply_bytes = 0
        reply = super().getreply()
        if self.sock is not None:
            # The TLS handshake after STARTTLS follows this reply with no write or read in between, and
            # runs under the timeout set now.
            self.sock.settimeout(self.budget.handshake())
        return reply

    def greet(self, *, helo_fallback: bool) -> None:
        """EHLO, raising a reply that is not 2xx as SMTPHeloError. smtplib's `ehlo` returns such a reply
        instead, which then reads as a server with no extensions: Gmail's `421 4.7.0 Try again later`
        became a permanent "no STARTTLS" or "no AUTH" configuration problem. With `helo_fallback` (before
        TLS) a 5xx is followed by HELO, as smtplib does for a server without ESMTP."""
        code, reply = self.ehlo()
        if 200 <= code <= 299:
            return
        if helo_fallback and 500 <= code <= 599:
            code, reply = self.helo()
            if 200 <= code <= 299:
                return
        raise smtplib.SMTPHeloError(code, reply)

    def login(self, user: str, password: str, *, initial_response_ok: bool = True) -> tuple[int, bytes]:
        """AUTH once, with the first of AUTH_MECHANISMS the server offers. smtplib's `login` tries each
        mechanism the server offers in turn: a wrong password was refused twice per message (twice
        towards the account's lockout), and a server that hangs up after the first refusal turned it
        into a dropped connection (retried, and without the sign-in hint)."""
        self.ehlo_or_helo_if_needed()
        if not self.has_extn("auth"):
            raise smtplib.SMTPNotSupportedError("SMTP AUTH extension not supported by server.")
        offered = self.esmtp_features["auth"].upper().split()
        mechanism = next((name for name in AUTH_MECHANISMS if name in offered), None)
        if mechanism is None:
            raise smtplib.SMTPException("No suitable authentication method found.")
        self.user, self.password = user, password
        respond = self.auth_plain if mechanism == "PLAIN" else self.auth_login
        return self.auth(mechanism, respond, initial_response_ok=initial_response_ok)


class _BoundedSMTPSSL(_BoundedSMTP, smtplib.SMTP_SSL):
    """`smtplib.SMTP_SSL` (TLS from the first byte) with the same bounded waits: the handshake gets the
    time left once the connection is made (smtplib gave it the whole timeout again)."""

    def _get_socket(self, host: str, port: int, timeout: float) -> socket.socket:
        sock = super()._get_socket(host, port, timeout)  # `_BoundedSMTP`'s: the TCP connection
        try:
            sock.settimeout(self.budget.wait())
            return self.context.wrap_socket(sock, server_hostname=host)  # what `connect` was given
        except BaseException:
            sock.close()
            raise


@dataclass(frozen=True, slots=True)
class _Prepared:
    message: EmailMessage
    envelope_from: str
    envelope_to: str
    message_id: str


class SmtpProvider:
    name = "smtp"

    def __init__(
        self,
        server: SmtpServer,
        *,
        ehlo_name: str = "localhost",
        ssl_context: ssl.SSLContext | None = None,
        clock: Callable[[], datetime] = app_time.now,
        monotonic: Callable[[], float] = time.monotonic,
    ) -> None:
        if (server.username is None) != (server.password is None):
            raise ValueError("an SMTP user name and password go together")
        if server.password is not None and not server.password.get_secret_value():
            raise ValueError("the SMTP password is empty")
        if server.security == "none" and server.username is not None:
            raise ValueError("SMTP credentials are never sent over an unencrypted connection")
        self._server = server
        self._ehlo_name = ehlo_name
        self._ssl_context = (
            None if server.security == "none" else (ssl_context or ssl.create_default_context())
        )
        self._clock = clock
        self._monotonic = monotonic
        self._reported: set[str] = set()
        self._lock = threading.Lock()

    def __repr__(self) -> str:
        server = self._server
        return f"SmtpProvider(host={server.host!r}, port={server.port}, security={server.security!r})"

    def send(self, email: OutgoingEmail, *, timeout_seconds: float | None = None) -> ProviderResult:
        prepared = _prepare(email, now=self._clock())
        allowed = DEFAULT_SEND_SECONDS if timeout_seconds is None else timeout_seconds
        if allowed <= 0:
            raise EmailDeliveryError("The mail server did not respond in time.", transient=True)
        budget = _Budget(self._server.timeout_seconds, self._monotonic() + allowed, self._monotonic)
        failure = self._attempt(prepared, budget)
        if failure is not None:
            # Raised here, outside the `except`, so the error keeps no reference to smtplib's exception
            # (whose frames hold the connection and, during AUTH, the password).
            raise failure
        with self._lock:
            self._reported.clear()
        return ProviderResult(provider_message_id=prepared.message_id)

    def _attempt(self, prepared: _Prepared, budget: _Budget) -> EmailDeliveryError | None:
        server = self._server
        client: _BoundedSMTP
        # The timeout given here is unused: every wait asks `budget` (`_BoundedSMTP`).
        if server.security == "ssl":
            client = _BoundedSMTPSSL(
                local_hostname=self._ehlo_name, timeout=server.timeout_seconds, context=self._ssl_context
            )
        else:
            client = _BoundedSMTP(local_hostname=self._ehlo_name, timeout=server.timeout_seconds)
        client.budget = budget
        stage: Stage = "connect"
        try:
            code, greeting = client.connect(server.host, server.port)
            if code != 220:  # what smtplib's constructor checks, and `connect` alone does not
                raise smtplib.SMTPConnectError(code, greeting)
            stage = "ehlo"
            client.greet(helo_fallback=True)
            if server.security == "starttls":
                stage = "starttls"
                client.starttls(context=self._ssl_context)
                stage = "ehlo"
                client.greet(helo_fallback=False)  # RFC 3207: only what the server offers over TLS
            if server.username is not None and server.password is not None:
                stage = "login"
                try:
                    client.login(server.username, server.password.get_secret_value())
                finally:
                    client.password = ""  # smtplib keeps it on the connection object
            stage = "send"
            client.send_message(
                prepared.message, from_addr=prepared.envelope_from, to_addrs=[prepared.envelope_to]
            )
        except Exception as exc:
            client.close()
            return self._failure(exc, stage)
        try:
            client.quit()
        except smtplib.SMTPException, OSError:
            client.close()  # the message was accepted; a slow goodbye changes nothing
        return None

    # ---- errors -------------------------------------------------------------------------------------

    def _failure(self, exc: Exception, stage: Stage) -> EmailDeliveryError:
        """`exc` as the dispatcher's transient/permanent error, with a message that names no secret, no
        address and none of the server's own text."""
        match exc:
            case smtplib.SMTPAuthenticationError(smtp_code=code, smtp_error=reply):
                if _is_temporary(code):
                    return _error(f"The mail server {_DEFERRED['login']} ({_label(code, reply)}).", True)
                self._report("credentials", code, reply)
                return _error(
                    f"The mail server refused the SMTP sign-in ({_label(code, reply)}); check SMTP_USERNAME "
                    "and SMTP_PASSWORD.",
                    False,
                )
            case smtplib.SMTPRecipientsRefused(recipients=refused):
                code, reply = next(iter(refused.values()), (-1, b""))
                return self._refusal(code, reply, "rejected the recipient address", "deferred the recipient")
            case smtplib.SMTPSenderRefused(smtp_code=code, smtp_error=reply):
                if not _is_temporary(code) and code != 530:
                    self._report("sender", code, reply)
                    return _error(
                        f"The mail server refused the sender address ({_label(code, reply)}); check "
                        "EMAIL_FROM.",
                        False,
                    )
                return self._refusal(code, reply, "refused the sender address", "deferred the sender")
            case smtplib.SMTPResponseException(smtp_code=code, smtp_error=reply):
                # SMTPDataError, SMTPConnectError, SMTPHeloError, and STARTTLS answered with an error.
                return self._refusal(code, reply, _REFUSED[stage], _DEFERRED[stage])
            case smtplib.SMTPNotSupportedError():
                if stage == "starttls":
                    self._report("starttls")
                    return _error(
                        "The mail server does not offer STARTTLS; check SMTP_SECURITY and SMTP_PORT.", False
                    )
                if stage == "login":
                    self._report("auth")
                    return _error(
                        "The mail server does not offer SMTP sign-in (AUTH) on this connection; check "
                        "SMTP_SECURITY and SMTP_PORT.",
                        False,
                    )
                return _error(
                    "The mail server cannot deliver to an address with non-ASCII characters (no SMTPUTF8).",
                    False,
                )
            case smtplib.SMTPServerDisconnected():
                if isinstance(exc.__context__, TimeoutError):
                    return _error("The mail server did not respond in time.", True)
                if isinstance(exc.__context__, _ReplyTooLong):
                    return _error("The mail server's reply was too long.", True)
                return _error("The mail server closed the connection.", True)
            case smtplib.SMTPException():
                # "No suitable authentication method found.", an endless AUTH challenge, ...
                if stage == "login":
                    self._report("auth")
                    return _error(
                        "The mail server offers no SMTP sign-in method this client supports.", False
                    )
                return _error(f"The mail server's reply could not be used ({type(exc).__name__}).", False)
            case ssl.SSLCertVerificationError():
                self._report("certificate")
                return _error(
                    f"The mail server's TLS certificate could not be verified ({_ssl_reason(exc)}).", False
                )
            case ssl.SSLError():
                return _error(
                    f"The TLS handshake with the mail server failed ({_ssl_reason(exc)}); check "
                    "SMTP_SECURITY and SMTP_PORT.",
                    True,
                )
            case TimeoutError():
                return _error("The mail server did not respond in time.", True)
            case ConnectionRefusedError():
                return _error("Could not connect to the mail server (connection refused).", True)
            case socket.gaierror():
                return _error("Could not connect to the mail server (SMTP_HOST could not be resolved).", True)
            case OSError():
                verb = "connect to" if stage == "connect" else "talk to"
                return _error(f"Could not {verb} the mail server ({type(exc).__name__}).", True)
        logger.error("unexpected SMTP error", extra={"error": type(exc).__name__, "stage": stage})
        return _error(f"Unexpected error while sending ({type(exc).__name__}).", False)

    def _refusal(self, code: int, reply: bytes | str, refused: str, deferred: str) -> EmailDeliveryError:
        label = _label(code, reply)
        if code == 530:  # "Authentication required", whichever command it answers
            self._report("sign-in-required", code, reply)
            return _error(f"The mail server requires SMTP sign-in ({label}).", False)
        if _is_temporary(code):
            return _error(f"The mail server {deferred} ({label}).", True)
        return _error(f"The mail server {refused} ({label}).", False)

    def _report(self, problem: str, code: int | None = None, reply: bytes | str = b"") -> None:
        """Log a configuration problem once, until a message is sent again."""
        with self._lock:
            if problem in self._reported:
                return
            self._reported.add(problem)
        detail = _CONFIGURATION_HINTS[problem]
        if code is not None:
            detail = f"{detail} ({_label(code, reply)})"
        logger.error("SMTP configuration problem: %s", detail, extra={"smtp_problem": problem})


def _error(message: str, transient: bool) -> EmailDeliveryError:
    return EmailDeliveryError(message, transient=transient)


def _is_temporary(code: int) -> bool:
    """4xx replies, and replies smtplib could not read a code from (-1)."""
    return not 500 <= code <= 599


def _label(code: int, reply: bytes | str) -> str:
    """`SMTP 550 5.1.1`: the reply code and, when the reply starts with one, the enhanced status code."""
    raw = reply.encode("utf-8", "replace") if isinstance(reply, str) else reply
    enhanced = _ENHANCED_STATUS.match(raw)
    return f"SMTP {code} {enhanced.group(1).decode('ascii')}" if enhanced else f"SMTP {code}"


def _ssl_reason(exc: ssl.SSLError) -> str:
    reason = getattr(exc, "reason", None)
    return (
        f"SSL: {reason}" if isinstance(reason, str) and _SSL_REASON.fullmatch(reason) else type(exc).__name__
    )


# ---- the message ------------------------------------------------------------------------------------


def _ascii_domain(domain: str) -> str:
    """The domain in its ASCII (IDNA) form; as given when it cannot be converted (then SMTPUTF8 decides)."""
    try:
        domain.encode("ascii")
        return domain
    except UnicodeEncodeError:
        pass
    try:
        return idna.encode(domain).decode("ascii")
    except idna.IDNAError, UnicodeError:
        return domain


def _mailbox(value: str) -> Address | None:
    """`Name <local@domain>` or a bare address as a header `Address`, or None when it holds no address."""
    name, address = parseaddr(sanitize_header(value))
    local, at, domain = address.rpartition("@")
    if not at or not local or not domain or "=?" in address:
        # RFC 2047 §5: no encoded word in an address. The `email` package would decode one in the header,
        # which would then name another mailbox than the envelope (and one a strict parser refuses).
        return None
    try:
        return Address(display_name=name, username=local, domain=_ascii_domain(domain))
    except ValueError, IndexError, MessageError:
        return None


def _prepare(email: OutgoingEmail, *, now: datetime) -> _Prepared:
    sender = _mailbox(email.sender)
    if sender is None:
        raise EmailDeliveryError("EMAIL_FROM is not a valid e-mail address.", transient=False)
    recipient = _mailbox(email.to)
    if recipient is None or recipient.display_name:
        raise EmailDeliveryError("The recipient is not a valid e-mail address.", transient=False)
    for image in email.inline_images:
        if not SAFE_CONTENT_ID.fullmatch(image.content_id) or not _MIME_TYPE.fullmatch(image.mime_type):
            raise EmailDeliveryError("Inline image has an invalid content id or type.", transient=False)
    id_domain = sender.domain if sender.domain.isascii() else "vms.invalid"
    message_id = f"<vms-email-{email.message_id}@{id_domain}>"
    try:
        message = EmailMessage(policy=SMTP_POLICY)
        message["From"] = sender
        message["To"] = recipient
        # A Reply-To that holds no address (only a misconfigured EMAIL_REPLY_TO can) is left out: the
        # message still goes out, and replies reach the sender.
        reply_to = _mailbox(email.reply_to) if email.reply_to else None
        if reply_to is not None:
            message["Reply-To"] = reply_to
        # The renderer already wrote the subject without an encoded word, for every provider
        # (`headers.subject_line`, B11-41). Here it matters twice: the `email` package would decode one
        # itself (encoding the text beforehand does not help: the package decodes that as well and writes
        # the decoded text out, for the client to decode again), so the step stays for any `OutgoingEmail`
        # built without the renderer.
        message["Subject"] = literal_text(sanitize_header(email.subject))
        message["Date"] = format_datetime(now)
        message["Message-ID"] = message_id
        message.set_content(email.text, cte="quoted-printable")
        message.add_alternative(email.html, subtype="html", cte="quoted-printable")
        if email.inline_images:
            html = next(part for part in message.iter_parts() if part.get_content_type() == "text/html")
            for image in email.inline_images:
                maintype, subtype = image.mime_type.split("/")
                html.add_related(
                    image.content,
                    maintype=maintype,
                    subtype=subtype,
                    cid=f"<{image.content_id}>",
                    filename=sanitize_header(image.filename) or f"{image.content_id}.{subtype}",
                    disposition="inline",
                )
    except (ValueError, TypeError, MessageError) as exc:
        raise EmailDeliveryError(
            f"The message could not be built ({type(exc).__name__}).", transient=False
        ) from None
    return _Prepared(
        message=message,
        envelope_from=sender.addr_spec,
        envelope_to=recipient.addr_spec,
        message_id=message_id.strip("<>"),
    )
