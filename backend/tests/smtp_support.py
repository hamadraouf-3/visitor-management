"""Real SMTP servers for the SMTP provider's tests (S10-7).

* `SmtpTestServer`: aiosmtpd (a dev/test-only dependency) on 127.0.0.1, with STARTTLS, implicit TLS or
  plain text, optional AUTH, and replies that a test can script per command (`handler.script("RCPT",
  "550 5.1.1 ...")`) or slow down (`handler.delay`). It records every accepted message as the bytes
  received after DATA.
* `RawServer`: a TCP listener for what aiosmtpd cannot do: no greeting at all, or a 4xx/5xx greeting.
* `ScriptedServer`: a TCP listener that hands each connection to a function of the test, for other
  misbehaviour: a reply spread out a line or a byte at a time, a reply that never ends, a hang-up right
  after a reply.
* `make_certificate`: a throwaway self-signed certificate for 127.0.0.1 (generated per test session with
  `cryptography`; no key is ever written into the repository), with a server context and a client
  context that trusts exactly this certificate.
"""

import asyncio
import datetime
import email
import ipaddress
import socket
import ssl
import threading
from collections.abc import Callable, Iterator
from contextlib import contextmanager, suppress
from dataclasses import dataclass, field
from email.message import EmailMessage
from email.policy import default as default_policy
from pathlib import Path
from typing import Any, Literal

from aiosmtpd.controller import Controller
from aiosmtpd.smtp import SMTP, AuthResult, LoginPassword
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID

HOST = "127.0.0.1"
Security = Literal["starttls", "ssl", "none"]


@dataclass(frozen=True)
class Certificate:
    cert_path: Path
    key_path: Path

    def server_context(self) -> ssl.SSLContext:
        context = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH)
        context.load_cert_chain(self.cert_path, self.key_path)
        return context

    def client_context(self) -> ssl.SSLContext:
        """What the provider uses in production (`ssl.create_default_context()`), trusting only this
        certificate instead of the system's."""
        return ssl.create_default_context(cafile=str(self.cert_path))


def make_certificate(directory: Path, host: str = HOST) -> Certificate:
    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, host)])
    now = datetime.datetime.now(datetime.UTC)
    certificate = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(minutes=5))
        .not_valid_after(now + datetime.timedelta(days=1))
        .add_extension(
            x509.SubjectAlternativeName([x509.IPAddress(ipaddress.ip_address(host))]), critical=False
        )
        .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
        .sign(key, hashes.SHA256())
    )
    cert_path, key_path = directory / "smtp-test-cert.pem", directory / "smtp-test-key.pem"
    cert_path.write_bytes(certificate.public_bytes(serialization.Encoding.PEM))
    key_path.write_bytes(
        key.private_bytes(
            serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
        )
    )
    return Certificate(cert_path, key_path)


@dataclass(frozen=True)
class Received:
    mail_from: str
    rcpt_tos: list[str]
    mail_options: list[str]
    data: bytes

    def message(self) -> EmailMessage:
        parsed = email.message_from_bytes(self.data, policy=default_policy)
        assert isinstance(parsed, EmailMessage)
        return parsed


@dataclass
class RecordingHandler:
    """aiosmtpd handler: accepts and records messages unless a reply is scripted for the command."""

    received: list[Received] = field(default_factory=list)
    scripted: dict[str, list[str]] = field(default_factory=dict)
    delay: float = 0.0  # before answering EHLO, MAIL, RCPT and DATA
    ehlo_names: list[str] = field(default_factory=list)

    def script(self, command: str, *replies: str) -> None:
        """The next replies to `command`, one per use; an empty reply answers as usual (so
        `script("EHLO", "", "421 ...")` scripts only the second EHLO: the one after STARTTLS)."""
        self.scripted.setdefault(command, []).extend(replies)

    def reset(self) -> None:
        self.received.clear()
        self.scripted.clear()
        self.ehlo_names.clear()
        self.delay = 0.0

    def _next(self, command: str) -> str | None:
        replies = self.scripted.get(command)
        return replies.pop(0) if replies else None

    async def handle_EHLO(  # noqa: N802 - aiosmtpd's hook names
        self, server: SMTP, session: Any, envelope: Any, hostname: str, responses: list[str]
    ) -> list[str]:
        self.ehlo_names.append(hostname)
        session.host_name = hostname  # aiosmtpd leaves this to an EHLO hook; MAIL and AUTH need it
        await asyncio.sleep(self.delay)
        if reply := self._next("EHLO"):
            return [reply]
        return responses

    async def handle_MAIL(  # noqa: N802
        self, server: SMTP, session: Any, envelope: Any, address: str, mail_options: list[str]
    ) -> str:
        await asyncio.sleep(self.delay)
        if (reply := self._next("MAIL")) is not None:
            return reply
        envelope.mail_from = address
        envelope.mail_options.extend(mail_options)
        return "250 OK"

    async def handle_RCPT(  # noqa: N802
        self, server: SMTP, session: Any, envelope: Any, address: str, rcpt_options: list[str]
    ) -> str:
        await asyncio.sleep(self.delay)
        if (reply := self._next("RCPT")) is not None:
            return reply
        envelope.rcpt_tos.append(address)
        return "250 OK"

    async def handle_DATA(self, server: SMTP, session: Any, envelope: Any) -> str:  # noqa: N802
        await asyncio.sleep(self.delay)
        if (reply := self._next("DATA")) is not None:
            return reply
        self.received.append(
            Received(
                mail_from=envelope.mail_from,
                rcpt_tos=list(envelope.rcpt_tos),
                mail_options=list(envelope.mail_options),
                data=bytes(envelope.original_content),
            )
        )
        return "250 2.0.0 Ok: queued"


class _Controller(Controller):
    def factory(self) -> SMTP:
        # The controller's own loop: without it aiosmtpd looks one up with warnings switched to errors in
        # its thread (`_get_or_new_eventloop`), which races with the test's warning filters.
        return SMTP(self.handler, loop=self.loop, **self.SMTP_kwargs)


@dataclass
class Credentials:
    username: str
    password: str
    # Reply to a failed sign-in (aiosmtpd's default is 535 5.7.8), e.g. Gmail's "534 5.7.9 ...".
    failure_reply: str | None = None
    attempts: int = 0


def free_port() -> int:
    with socket.socket() as probe:
        probe.bind((HOST, 0))
        return int(probe.getsockname()[1])


class SmtpTestServer:
    def __init__(
        self,
        *,
        security: Security = "none",
        certificate: Certificate | None = None,
        credentials: Credentials | None = None,
        **smtp_options: Any,
    ) -> None:
        """`smtp_options` go to aiosmtpd's SMTP class as given (e.g. `enable_SMTPUTF8=False`)."""
        self.handler = RecordingHandler()
        self.credentials = credentials
        self.security = security
        options: dict[str, Any] = {"ready_timeout": 5.0}
        if security != "none":
            assert certificate is not None
            context = certificate.server_context()
            if security == "starttls":
                options |= {"tls_context": context, "require_starttls": True}
            else:
                options |= {"ssl_context": context, "auth_require_tls": False}
        if credentials is not None:
            options["authenticator"] = self._authenticate
        self._options = options | smtp_options
        self._controller: _Controller | None = None

    def _authenticate(
        self, server: SMTP, session: Any, envelope: Any, mechanism: str, data: Any
    ) -> AuthResult:
        credentials = self.credentials
        assert credentials is not None
        credentials.attempts += 1
        accepted = (
            isinstance(data, LoginPassword)
            and data.login.decode() == credentials.username
            and data.password.decode() == credentials.password
        )
        if accepted:
            return AuthResult(success=True, handled=False)
        # handled=False: aiosmtpd answers (with `message`, or its 535 5.7.8) instead of staying silent.
        return AuthResult(success=False, handled=False, message=credentials.failure_reply)

    @property
    def port(self) -> int:
        assert self._controller is not None
        return int(self._controller.port)

    def start(self) -> SmtpTestServer:
        for attempt in range(3):  # a free port can be taken between probing and binding
            controller = _Controller(self.handler, hostname=HOST, port=free_port(), **self._options)
            try:
                controller.start()
            except Exception:
                if attempt == 2:
                    raise
                continue
            self._controller = controller
            return self
        raise AssertionError("unreachable")  # pragma: no cover

    def stop(self) -> None:
        if self._controller is not None:
            self._controller.stop()
            self._controller = None


@contextmanager
def smtp_server(**options: Any) -> Iterator[SmtpTestServer]:
    server = SmtpTestServer(**options).start()
    try:
        yield server
    finally:
        server.stop()


class RawServer:
    """Accepts TCP connections on 127.0.0.1, sends `greeting` (nothing when None) and holds them open."""

    def __init__(self, greeting: bytes | None = None) -> None:
        self._greeting = greeting
        self._listener = socket.create_server((HOST, 0))
        self._listener.settimeout(0.1)
        self._connections: list[socket.socket] = []
        self._stopping = threading.Event()
        self._thread = threading.Thread(target=self._serve, name="raw-smtp-test-server", daemon=True)
        self.port = int(self._listener.getsockname()[1])

    def _serve(self) -> None:
        while not self._stopping.is_set():
            try:
                connection, _address = self._listener.accept()
            except TimeoutError:
                continue
            except OSError:
                return
            self._connections.append(connection)
            if self._greeting is not None:
                connection.sendall(self._greeting)

    def __enter__(self) -> RawServer:
        self._thread.start()
        return self

    def __exit__(self, *exc_info: object) -> None:
        self._stopping.set()
        self._thread.join(5)
        self._listener.close()
        for connection in self._connections:
            connection.close()


class ScriptedServer:
    """Accepts TCP connections on 127.0.0.1 and runs `serve(connection, stopping)` for each in a thread of
    its own. `stopping` is set when the test leaves the `with` block; a connection error inside `serve`
    (the client hung up) ends it quietly. `connections` counts the connections accepted."""

    def __init__(self, serve: Callable[[socket.socket, threading.Event], None]) -> None:
        self._serve = serve
        self._listener = socket.create_server((HOST, 0))
        self._listener.settimeout(0.1)
        self._stopping = threading.Event()
        self._handlers: list[threading.Thread] = []
        self._thread = threading.Thread(target=self._accept, name="scripted-smtp-test-server", daemon=True)
        self.port = int(self._listener.getsockname()[1])
        self.connections = 0

    def _accept(self) -> None:
        while not self._stopping.is_set():
            try:
                connection, _address = self._listener.accept()
            except TimeoutError:
                continue
            except OSError:
                return
            self.connections += 1
            handler = threading.Thread(target=self._handle, args=(connection,), daemon=True)
            self._handlers.append(handler)
            handler.start()

    def _handle(self, connection: socket.socket) -> None:
        connection.settimeout(10.0)  # a server thread never outlives a broken test by long
        with connection, suppress(OSError):  # ssl.SSLError and TimeoutError included
            self._serve(connection, self._stopping)

    def __enter__(self) -> ScriptedServer:
        self._thread.start()
        return self

    def __exit__(self, *exc_info: object) -> None:
        self._stopping.set()
        self._thread.join(5)
        self._listener.close()
        for handler in self._handlers:
            handler.join(5)


def closed_port() -> int:
    """A port nothing listens on (bound and released at once)."""
    return free_port()
