"""Smoke test of a deployed Mawdoo3 Visitors stack through its public HTTPS entry point (nginx).

    python3 deploy/verify/smoke_test.py --base-url https://vms.example.com [options]

Standard library only; run it after every deployment and after any change of the nginx configuration
(security audit, recommendation 2: "re-run the header, proxy and TLS checks against the deployed stack").
It checks what the browser and the API rely on:

* the security headers of the SPA (deploy/nginx/snippets/security-headers.conf, itself kept identical to
  frontend/config/securityHeaders.ts) on the shell, deep links (/pass, /reset-password, ...), static files
  and error responses; `Server` without a version;
* caching: no-store for the shell and every SPA fallback, no-cache for sw.js, the precache list and
  appearance.js (the page's colour scheme before its first paint, a script of its own: it must arrive as
  JavaScript, or every page starts in the light scheme), immutable for hashed assets; every precached
  URL answers 200 (otherwise the service worker never installs); the zxing decoder is served as
  application/wasm; gzip for static files;
* missing files answer 404, never the HTML shell; the API schema (/openapi.json) is not reachable;
* the API through the proxy: its own headers (no-store, its CSP, HSTS), nginx's request ID replacing the
  client's, an Upgrade request answered as plain HTTP; each of the three API instances (main,
  reception lists, reports) answers the paths nginx routes to it;
* the body limit: 65,536 bytes pass to the API, one more byte (or a larger chunked body) gets nginx's 413
  in the API's JSON envelope; the one larger body, the upload of a company's brand image, passes with up
  to 524,288 bytes on exactly its path; and that upload is handed to the API before its body arrives, so
  that a request nobody is signed in for is answered at once and keeps no place among the uploads in
  progress;
* the public identity endpoints (a company's name, brand and manifest, read before anyone signs in)
  reach the API, and what the API says about caching arrives unchanged;
* unknown host names: no TLS handshake for an unknown SNI, no answer for an unknown Host header;
* optionally (--http-url) the HTTP -> HTTPS redirect, and (--admin-email, password in the
  VMS_SMOKE_PASSWORD environment variable) that the client address recorded by the API is the real peer,
  not a spoofed X-Forwarded-For, and that the audit row carries nginx's request ID.

Exit status 0 when every check passed, 1 otherwise. Options: --help.
"""

from __future__ import annotations

import argparse
import gzip
import http.client
import json
import os
import re
import secrets
import socket
import ssl
import sys
import time
import urllib.parse
from collections.abc import Iterable
from dataclasses import dataclass, field
from pathlib import Path

HERE = Path(__file__).resolve().parent
SPA_HEADERS_SNIPPET = HERE.parent / "nginx" / "snippets" / "security-headers.conf"
API_ERROR_HEADERS_SNIPPET = HERE.parent / "nginx" / "snippets" / "api-error-headers.conf"
SNIPPET_LINE = re.compile(r'^add_header\s+([A-Za-z0-9-]+)\s+"([^"]*)"\s+always;$')

# The API's own headers (backend app/core/middleware.py), checked on proxied API responses.
API_HEADERS = {
    "cache-control": "no-store",
    "content-security-policy": (
        "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
    ),
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
}
HSTS = "max-age=31536000; includeSubDomains"
NGINX_REQUEST_ID = re.compile(r"^[0-9a-f]{32}$")
BODY_LIMIT = 65536
# The upload of a company's brand image (the API's BRAND_ASSET_MAX_BYTES; nginx: the nested location of
# /api/ in templates/vms.conf.template). No company has this ID: nobody is signed in here anyway.
BRAND_UPLOAD_LIMIT = 512 * 1024
BRAND_UPLOAD_PATH = "/api/v1/platform/companies/00000000-0000-4000-8000-000000000000/brand/assets/logo"
# Uploads nginx lets one client address have in progress (`limit_conn vms_brand_upload_client`).
BRAND_UPLOADS_PER_ADDRESS = 4
# One path per API instance (the routing map in deploy/nginx/templates/vms.conf.template).
API_INSTANCE_PATHS = (
    ("main", "/api/v1/auth/me"),
    ("reception-list", "/api/v1/reception/today"),
    ("reporting", "/api/v1/reports/summary"),
)
DEEP_LINKS = (
    "/",
    "/index.html",
    "/login",
    "/pass",
    "/reset-password",
    "/reception",
    "/visits/00000000-0000-4000-8000-000000000000",
    "/admin/users",
)


def snippet_headers(path: Path) -> dict[str, str]:
    """Header name (lowercase) -> value of an nginx snippet; variables ($...) are skipped."""
    headers: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        match = SNIPPET_LINE.match(line.strip())
        if match and "$" not in match.group(2):
            headers[match.group(1).lower()] = match.group(2)
    if not headers:
        raise SystemExit(f"no add_header lines found in {path}")
    return headers


@dataclass
class Response:
    status: int
    headers: dict[str, list[str]]
    body: bytes

    def header(self, name: str) -> str | None:
        values = self.headers.get(name.lower())
        return None if not values else values[0]

    def all(self, name: str) -> list[str]:
        return self.headers.get(name.lower(), [])

    def json(self) -> object:
        return json.loads(self.body.decode("utf-8"))


class NoResponse(Exception):
    """The server closed the connection (or refused the TLS handshake) without an HTTP response."""


def read_response(sock: socket.socket) -> Response:
    """One HTTP/1.1 response read from `sock`, which is left as it is (`Client.begin_upload`)."""
    data = b""
    while b"\r\n\r\n" not in data:
        piece = sock.recv(65536)
        if not piece:
            raise ConnectionError("the connection ended before a response")
        data += piece
    head, _, body = data.partition(b"\r\n\r\n")
    status_line, *header_lines = head.decode("latin-1").split("\r\n")
    headers: dict[str, list[str]] = {}
    for line in header_lines:
        name, _, value = line.partition(":")
        headers.setdefault(name.strip().lower(), []).append(value.strip())
    length = int(headers.get("content-length", ["0"])[0])
    while len(body) < length:
        piece = sock.recv(65536)
        if not piece:
            break
        body += piece
    return Response(int(status_line.split()[1]), headers, body[:length])


@dataclass
class Client:
    host: str
    port: int
    scheme: str
    connect_to: str | None
    context: ssl.SSLContext | None
    source_address: str | None
    timeout: float = 15.0

    def _socket(self, sni: str | None) -> socket.socket:
        source = (self.source_address, 0) if self.source_address else None
        sock = socket.create_connection((self.connect_to or self.host, self.port), self.timeout, source)
        if self.scheme == "https":
            if self.context is None:
                raise ValueError("an https client needs a TLS context")
            try:
                return self.context.wrap_socket(sock, server_hostname=sni or self.host)
            except (ssl.SSLError, OSError) as exc:
                sock.close()
                raise NoResponse(f"TLS handshake failed: {exc}") from exc
        return sock

    def begin_upload(
        self, method: str, path: str, *, headers: dict[str, str], declared_length: int, wait: float = 5.0
    ) -> tuple[Response, socket.socket]:
        """A request that declares a body of `declared_length` bytes and sends none of it: the answer
        that comes within `wait` seconds while the body is still awaited, and the connection, which
        this side keeps open (nothing more is sent, nothing is closed) until the caller closes it.
        `NoResponse` when no answer comes."""
        sock = self._socket(None)
        try:
            default_host = self.host if self.port in (80, 443) else f"{self.host}:{self.port}"
            lines = [f"{method} {path} HTTP/1.1", f"Host: {default_host}", "User-Agent: vms-smoke-test/1"]
            lines += [f"{name}: {value}" for name, value in headers.items()]
            lines.append(f"Content-Length: {declared_length}")
            sock.sendall(("\r\n".join(lines) + "\r\n\r\n").encode("ascii"))
            sock.settimeout(wait)
            return read_response(sock), sock
        except (OSError, ValueError) as exc:
            sock.close()
            raise NoResponse(f"no answer while the body was awaited ({type(exc).__name__})") from exc

    def request(
        self,
        method: str,
        path: str,
        *,
        headers: dict[str, str] | None = None,
        body: bytes | Iterable[bytes] | None = None,
        host_header: str | None = None,
        sni: str | None = None,
        chunked: bool = False,
    ) -> Response:
        connection = http.client.HTTPConnection(self.host, self.port, timeout=self.timeout)
        connection.sock = self._socket(sni)
        try:
            connection.putrequest(method, path, skip_host=True, skip_accept_encoding=True)
            default_host = self.host if self.port in (80, 443) else f"{self.host}:{self.port}"
            connection.putheader("Host", host_header or default_host)
            sent = {"host"}
            for name, value in (headers or {}).items():
                connection.putheader(name, value)
                sent.add(name.lower())
            if "user-agent" not in sent:
                connection.putheader("User-Agent", "vms-smoke-test/1")
            if chunked:
                connection.putheader("Transfer-Encoding", "chunked")
                connection.endheaders()
                for chunk in body or ():  # type: ignore[union-attr]
                    connection.send(f"{len(chunk):x}\r\n".encode() + chunk + b"\r\n")
                connection.send(b"0\r\n\r\n")
            else:
                if body is not None:
                    connection.putheader("Content-Length", str(len(body)))  # type: ignore[arg-type]
                connection.endheaders(body if isinstance(body, bytes) else None)
            try:
                raw = connection.getresponse()
            except (http.client.RemoteDisconnected, http.client.BadStatusLine, ConnectionError) as exc:
                raise NoResponse(f"connection closed without a response ({type(exc).__name__})") from exc
            response_headers: dict[str, list[str]] = {}
            for name, value in raw.getheaders():
                response_headers.setdefault(name.lower(), []).append(value)
            return Response(raw.status, response_headers, raw.read())
        except (ConnectionError, ssl.SSLError) as exc:
            raise NoResponse(f"connection failed: {exc}") from exc
        finally:
            connection.close()


@dataclass
class Report:
    failures: list[str] = field(default_factory=list)
    passed: int = 0

    def check(self, name: str, ok: bool, detail: str = "") -> bool:
        if ok:
            self.passed += 1
            print(f"PASS  {name}")
        else:
            self.failures.append(name)
            print(f"FAIL  {name}{': ' + detail if detail else ''}")
        return ok


def header_problems(response: Response, expected: dict[str, str]) -> list[str]:
    problems = []
    for name, value in expected.items():
        served = response.all(name)
        if len(served) != 1:
            problems.append(f"{name}: expected once, got {served!r}")
        elif served[0] != value:
            problems.append(f"{name}: expected {value!r}, got {served[0]!r}")
    return problems


def check_spa_headers(report: Report, label: str, response: Response, spa_headers: dict[str, str]) -> None:
    problems = header_problems(response, spa_headers)
    report.check(f"{label}: security headers", not problems, "; ".join(problems))


def precache_urls(client: Client) -> list[str]:
    response = client.request("GET", "/sw-precache-manifest.js")
    text = response.body.decode("utf-8")
    match = re.search(r"=\s*(\{.*\})\s*;?\s*$", text, re.S)
    if response.status != 200 or not match:
        return []
    return list(json.loads(match.group(1))["urls"])


def run(args: argparse.Namespace) -> Report:
    base = urllib.parse.urlsplit(args.base_url)
    if base.scheme != "https" or not base.hostname or base.path not in ("", "/"):
        raise SystemExit("--base-url must be an https origin, e.g. https://vms.example.com")
    context = ssl.create_default_context(cafile=args.cafile)
    if args.insecure:
        context.check_hostname = False
        context.verify_mode = ssl.CERT_NONE
    client = Client(base.hostname, base.port or 443, "https", args.connect_to, context, args.source_address)
    origin = f"https://{base.hostname}" + (f":{base.port}" if base.port and base.port != 443 else "")
    spa_headers = snippet_headers(SPA_HEADERS_SNIPPET)
    api_error_headers = snippet_headers(API_ERROR_HEADERS_SNIPPET)
    report = Report()
    marker = secrets.token_hex(6)

    # --- TLS ---------------------------------------------------------------------------------------
    probe = client._socket(None)
    if not isinstance(probe, ssl.SSLSocket):
        raise SystemExit("--base-url must be an https origin")
    version, cipher = probe.version(), (probe.cipher() or ("?",))[0]
    probe.close()
    report.check(f"TLS handshake ({version}, {cipher})", version in ("TLSv1.2", "TLSv1.3"))

    # --- the application shell and deep links --------------------------------------------------------
    for path in (*DEEP_LINKS, *args.deep_link):
        response = client.request("GET", path)
        ok = (
            response.status == 200
            and (response.header("content-type") or "").startswith("text/html")
            and b'<div id="root">' in response.body
        )
        report.check(f"GET {path}: 200 HTML shell", ok, f"status {response.status}")
        report.check(
            f"GET {path}: Cache-Control no-store",
            response.header("cache-control") == "no-store",
            repr(response.header("cache-control")),
        )
        check_spa_headers(report, f"GET {path}", response, spa_headers)
        if path == "/":
            server = response.header("server")
            report.check("Server header without version", server in (None, "nginx"), repr(server))
            report.check("no X-Powered-By", response.header("x-powered-by") is None)
            shell = response.body.decode("utf-8")
    scripts = re.findall(r'src="(/assets/[^"]+\.js)"', shell)
    styles = re.findall(r'href="(/assets/[^"]+\.css)"', shell)

    # --- hashed assets, the service worker, the precache list ---------------------------------------
    for path in (*scripts[:1], *styles[:1]):
        response = client.request("GET", path)
        report.check(f"GET {path}: 200", response.status == 200, f"status {response.status}")
        report.check(
            f"GET {path}: immutable",
            response.header("cache-control") == "public, max-age=31536000, immutable",
            repr(response.header("cache-control")),
        )
        check_spa_headers(report, f"GET {path}", response, spa_headers)
        compressed = client.request("GET", path, headers={"Accept-Encoding": "gzip"})
        gzip_ok = (
            compressed.header("content-encoding") == "gzip"
            and gzip.decompress(compressed.body) == response.body
        )
        report.check(f"GET {path}: gzip", gzip_ok, repr(compressed.header("content-encoding")))
        report.check(
            f"GET {path}: Vary Accept-Encoding",
            "Accept-Encoding" in ",".join(compressed.all("vary")),
            repr(compressed.all("vary")),
        )
    script_type = client.request("GET", scripts[0]).header("content-type") if scripts else None
    report.check(
        "JavaScript served as application/javascript",
        (script_type or "").startswith("application/javascript"),
        repr(script_type),
    )

    for path in ("/sw.js", "/sw-precache-manifest.js", "/appearance.js"):
        response = client.request("GET", path)
        report.check(
            f"GET {path}: 200 JavaScript",
            response.status == 200 and "javascript" in (response.header("content-type") or ""),
            f"status {response.status} {response.header('content-type')!r}",
        )
        report.check(
            f"GET {path}: Cache-Control no-cache",
            response.header("cache-control") == "no-cache",
            repr(response.header("cache-control")),
        )
        check_spa_headers(report, f"GET {path}", response, spa_headers)

    urls = precache_urls(client)
    report.check("precache list readable", bool(urls), "sw-precache-manifest.js could not be parsed")
    failing = [url for url in urls if client.request("GET", url).status != 200]
    report.check(f"all {len(urls)} precached URLs answer 200", not failing, ", ".join(failing))
    wasm = [url for url in urls if url.endswith(".wasm")]
    report.check("precache list contains the zxing .wasm", bool(wasm))
    for url in wasm:
        response = client.request("GET", url)
        report.check(
            f"GET {url}: application/wasm",
            response.header("content-type") == "application/wasm",
            repr(response.header("content-type")),
        )
        report.check(
            f"GET {url}: immutable",
            response.header("cache-control") == "public, max-age=31536000, immutable",
            repr(response.header("cache-control")),
        )
        report.check(f"GET {url}: WebAssembly magic", response.body[:4] == b"\0asm")

    manifest = client.request("GET", "/manifest.webmanifest")
    report.check(
        "manifest.webmanifest: application/manifest+json",
        (manifest.header("content-type") or "").startswith("application/manifest+json"),
        repr(manifest.header("content-type")),
    )
    report.check(
        "manifest.webmanifest: no-cache",
        manifest.header("cache-control") == "no-cache",
        repr(manifest.header("cache-control")),
    )

    # --- missing files are 404, never the shell -----------------------------------------------------
    for path in (f"/assets/missing-{marker}.js", f"/missing-{marker}.png", "/openapi.json", "/.env"):
        response = client.request("GET", path)
        report.check(
            f"GET {path}: 404 (not the HTML shell)",
            response.status == 404 and b'<div id="root">' not in response.body,
            f"status {response.status}",
        )
        if path.startswith("/assets/"):
            report.check(
                f"GET {path}: 404 not cacheable as immutable",
                "immutable" not in (response.header("cache-control") or ""),
                repr(response.header("cache-control")),
            )
            check_spa_headers(report, f"GET {path} (404)", response, spa_headers)

    # --- the API through the proxy -------------------------------------------------------------------
    spoofed_id = f"smoke-spoofed-{marker}"
    health = client.request(
        "GET", "/api/v1/health", headers={"X-Request-ID": spoofed_id, "Accept": "application/json"}
    )
    report.check(
        "GET /api/v1/health: 200 ok",
        health.status == 200 and health.json() == {"status": "ok", "database": "ok"},
        f"status {health.status} {health.body[:200]!r}",
    )
    problems = header_problems(health, API_HEADERS)
    report.check("API response: the API's own headers, once each", not problems, "; ".join(problems))
    if args.expect_hsts:
        report.check(
            "API response: HSTS (APP_ENV=production)",
            health.all("strict-transport-security") == [HSTS],
            repr(health.all("strict-transport-security")),
        )
    request_id = health.header("x-request-id") or ""
    report.check(
        "API request ID is nginx's, not the client's",
        bool(NGINX_REQUEST_ID.match(request_id)) and request_id != spoofed_id,
        repr(request_id),
    )
    report.check(
        "API response: no SPA CSP added by nginx",
        "'self'" not in (health.header("content-security-policy") or ""),
    )

    # Each API instance answers its share of the paths (deploy/README.md §4): nginx's $vms_api_pool map
    # sends these unauthenticated GETs to the main, reception-list and reporting instance. The API's own
    # 401 proves that instance is up; nginx answers 503 SERVICE_BUSY for one it cannot reach.
    for instance, path in API_INSTANCE_PATHS:
        response = client.request("GET", path, headers={"Accept": "application/json"})
        envelope = response.json() if response.body.startswith(b"{") else {}
        report.check(
            f"{instance} instance answers (GET {path}: the API's 401)",
            response.status == 401
            and isinstance(envelope, dict)
            and envelope.get("error", {}).get("code") == "NOT_AUTHENTICATED"
            and envelope.get("request_id") == response.header("x-request-id")
            and bool(NGINX_REQUEST_ID.match(str(envelope.get("request_id")))),
            f"status {response.status} {response.body[:200]!r}",
        )

    upgrade = client.request(
        "GET",
        "/api/v1/health",
        headers={
            "Connection": "Upgrade",
            "Upgrade": "websocket",
            "Sec-WebSocket-Version": "13",
            "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
        },
    )
    report.check(
        "Upgrade request answered as plain HTTP (no 101)", upgrade.status == 200, f"status {upgrade.status}"
    )

    # --- request body limit (MAX_REQUEST_BODY_BYTES = client_max_body_size = 64 KiB) -------------------
    def login_body(size: int) -> bytes:
        prefix = b'{"email":"smoke-' + marker.encode() + b'@invalid.test","password":"x","pad":"'
        suffix = b'"}'
        return prefix + b"a" * (size - len(prefix) - len(suffix)) + suffix

    json_headers = {"Content-Type": "application/json", "Origin": origin}
    at_limit = client.request("POST", "/api/v1/auth/login", headers=json_headers, body=login_body(BODY_LIMIT))
    at_limit_api = at_limit.status != 413 and "request_id" in (
        at_limit.json() if at_limit.body.startswith(b"{") else {}
    )
    report.check(
        f"POST {BODY_LIMIT} bytes reaches the API (not 413)", at_limit_api, f"status {at_limit.status}"
    )
    over = client.request("POST", "/api/v1/auth/login", headers=json_headers, body=login_body(BODY_LIMIT + 1))
    envelope = over.json() if over.body.startswith(b"{") else {}
    report.check(
        f"POST {BODY_LIMIT + 1} bytes: 413 PAYLOAD_TOO_LARGE envelope",
        over.status == 413
        and isinstance(envelope, dict)
        and envelope.get("error", {}).get("code") == "PAYLOAD_TOO_LARGE"
        and bool(NGINX_REQUEST_ID.match(str(envelope.get("request_id")))),
        f"status {over.status} {over.body[:200]!r}",
    )
    problems = header_problems(over, api_error_headers)
    report.check(
        "413 carries the API headers",
        not problems and over.header("x-request-id") == envelope.get("request_id"),
        "; ".join(problems),
    )
    try:
        chunked = client.request(
            "POST", "/api/v1/auth/login", headers=json_headers, body=[b"a" * 16384] * 5, chunked=True
        )
        report.check("chunked body over 64 KiB: 413", chunked.status == 413, f"status {chunked.status}")
    except NoResponse as exc:
        report.check("chunked body over 64 KiB: 413", False, str(exc))

    # --- the one larger body: a company's brand image ---------------------------------------------------
    # Nobody is signed in, so the API answers 401 without reading the body. That answer, and not nginx's
    # 413, shows that nginx lets a body above 64 KiB through on this path, and only up to the API's limit.
    #
    # The upload is also the one request nginx counts while it is in progress (8 on the site, 4 from one
    # address), and a place is taken before anyone is asked who they are. So nginx hands this request to
    # the API with its header, before any of the body arrived (B12-18): the 401 comes while the body is
    # still awaited, and the request's place is free again with that answer. A deployment that read the
    # body first would answer nothing here until the body came.
    def error_of(response: Response) -> tuple[int, object]:
        answer = response.json() if response.body.startswith(b"{") else {}
        return response.status, answer.get("error", {}).get("code") if isinstance(answer, dict) else None

    png_headers = {"Content-Type": "image/png", "Origin": origin}
    begun: list[socket.socket] = []
    try:
        started = time.monotonic()
        upload, connection = client.begin_upload(
            "PUT", BRAND_UPLOAD_PATH, headers=png_headers, declared_length=BRAND_UPLOAD_LIMIT
        )
        begun.append(connection)
        report.check(
            f"PUT declaring {BRAND_UPLOAD_LIMIT} bytes to the brand image upload: the API's 401 (not 413) "
            "before any of the body is sent",
            error_of(upload) == (401, "NOT_AUTHENTICATED") and time.monotonic() - started < 5,
            f"status {upload.status} {upload.body[:200]!r}",
        )
        # Seven more, one after the other, every connection left open and silent: more than one address
        # may have in progress. All are answered by the API, so none of them kept a place.
        answers = [error_of(upload)]
        for _ in range(BRAND_UPLOADS_PER_ADDRESS + 3):
            answer, connection = client.begin_upload(
                "PUT", BRAND_UPLOAD_PATH, headers=png_headers, declared_length=BRAND_UPLOAD_LIMIT
            )
            begun.append(connection)
            answers.append(error_of(answer))
        report.check(
            f"{len(answers)} uploads begun without a session, each connection left open: none keeps a place "
            "(the API's 401 every time, never 503)",
            answers == [(401, "NOT_AUTHENTICATED")] * len(answers),
            repr(answers),
        )
    except NoResponse as exc:
        report.check("an upload nobody is signed in for is answered before its body arrives", False, str(exc))
    finally:
        for connection in begun:
            connection.close()
    try:
        too_large = client.request(
            "PUT", BRAND_UPLOAD_PATH, headers=png_headers, body=b"a" * (BRAND_UPLOAD_LIMIT + 1)
        )
        report.check(
            f"PUT {BRAND_UPLOAD_LIMIT + 1} bytes to the brand image upload: 413 PAYLOAD_TOO_LARGE envelope",
            error_of(too_large) == (413, "PAYLOAD_TOO_LARGE"),
            f"status {too_large.status} {too_large.body[:200]!r}",
        )
        beside = client.request(
            "PUT", BRAND_UPLOAD_PATH + "/x", headers=png_headers, body=b"a" * (BODY_LIMIT + 1)
        )
        report.check(
            "the larger limit is the upload's alone (one segment more: 413 above 64 KiB)",
            error_of(beside) == (413, "PAYLOAD_TOO_LARGE"),
            f"status {beside.status} {beside.body[:200]!r}",
        )
    except NoResponse as exc:
        report.check("the brand image upload's body limit", False, str(exc))

    # --- the public identity endpoints ---------------------------------------------------------------
    # A slug no company has: the API's own 404, never stored (the company may exist tomorrow). nginx
    # adds no caching rule of its own to these answers; the API alone says how long one may be kept.
    for rest in ("brand", "brand/logo.png", "manifest.webmanifest"):
        path = f"/api/v1/public/companies/smoke-{marker}/{rest}"
        public = client.request("GET", path, headers={"Accept": "*/*"})
        report.check(
            f"GET {path}: the API's 404, no-store",
            error_of(public) == (404, "NOT_FOUND") and public.all("cache-control") == ["no-store"],
            f"status {public.status} {public.all('cache-control')!r}",
        )

    # --- unknown host names ------------------------------------------------------------------------
    unverified = ssl.create_default_context()
    unverified.check_hostname = False
    unverified.verify_mode = ssl.CERT_NONE
    stranger = Client(base.hostname, client.port, "https", args.connect_to, unverified, args.source_address)
    try:
        stranger.request("GET", "/", sni=f"unknown-{marker}.invalid", host_header=f"unknown-{marker}.invalid")
        report.check("TLS handshake refused for an unknown SNI", False, "the server answered")
    except NoResponse as exc:
        report.check("TLS handshake refused for an unknown SNI", "handshake" in str(exc), str(exc))
    try:
        response = client.request("GET", "/", host_header=f"unknown-{marker}.invalid")
        report.check("unknown Host header gets no answer", False, f"status {response.status}")
    except NoResponse:
        report.check("unknown Host header gets no answer", True)

    # --- HTTP -> HTTPS -----------------------------------------------------------------------------
    if args.http_url:
        http_base = urllib.parse.urlsplit(args.http_url)
        # Connects to the --http-url host (a name or an address) and names the application in Host.
        plain = Client(
            http_base.hostname or base.hostname, http_base.port or 80, "http", None, None, args.source_address
        )
        response = plain.request("GET", "/visits?tab=today", host_header=base.hostname)
        location = response.header("location")
        report.check(
            "HTTP redirects to HTTPS (301, path and query kept)",
            response.status == 301 and location == f"{origin}/visits?tab=today",
            f"status {response.status} location {location!r}",
        )
        try:
            response = plain.request("GET", "/", host_header=f"unknown-{marker}.invalid")
            report.check("HTTP: unknown Host header gets no answer", False, f"status {response.status}")
        except NoResponse:
            report.check("HTTP: unknown Host header gets no answer", True)

    # --- client address and request ID as the API records them ---------------------------------------
    if args.admin_email:
        check_client_address(report, client, origin, args, marker)
    return report


def cookies_of(response: Response) -> dict[str, str]:
    jar = {}
    for value in response.all("set-cookie"):
        name, _, rest = value.partition("=")
        jar[name.strip()] = rest.split(";", 1)[0]
    return jar


def check_client_address(
    report: Report, client: Client, origin: str, args: argparse.Namespace, marker: str
) -> None:
    password = os.environ.get("VMS_SMOKE_PASSWORD")
    if not password:
        report.check("client address check", False, "set VMS_SMOKE_PASSWORD (never on the command line)")
        return
    spoofed_ip, spoofed_id = "203.0.113.77", f"smoke-spoofed-{marker}"
    body = json.dumps({"email": args.admin_email, "password": password}).encode()
    login = client.request(
        "POST",
        "/api/v1/auth/login",
        headers={
            "Content-Type": "application/json",
            "Origin": origin,
            "X-Forwarded-For": spoofed_ip,
            "X-Request-ID": spoofed_id,
            "Forwarded": f"for={spoofed_ip}",
            "X-Real-IP": spoofed_ip,
        },
        body=body,
    )
    if not report.check(
        "admin sign-in through the proxy", login.status == 200, f"status {login.status} {login.body[:200]!r}"
    ):
        return
    login_request_id = login.header("x-request-id")
    jar = cookies_of(login)
    cookie = "; ".join(f"{name}={value}" for name, value in jar.items())
    csrf = next((value for name, value in jar.items() if name.endswith("vms_csrf")), "")
    try:
        query = urllib.parse.urlencode({"action": "AUTH_LOGIN_SUCCEEDED", "page_size": 5})
        audit = client.request(
            "GET", f"/api/v1/audit-logs?{query}", headers={"Cookie": cookie, "Accept": "application/json"}
        )
        rows = audit.json().get("items", []) if audit.status == 200 else []  # type: ignore[union-attr]
        row = next((item for item in rows if item.get("request_id") == login_request_id), None)
        found = report.check(
            "audit row of the sign-in found by nginx's request ID",
            row is not None,
            f"status {audit.status}, request id {login_request_id!r}",
        )
        if not found or row is None:
            return
        recorded = row.get("ip_address")
        report.check(
            "recorded client address is not the spoofed X-Forwarded-For",
            recorded not in (spoofed_ip, None),
            repr(recorded),
        )
        if args.expect_client_ip:
            report.check(
                f"recorded client address is the real peer {args.expect_client_ip}",
                recorded == args.expect_client_ip,
                repr(recorded),
            )
        report.check(
            "recorded request ID is not the client's",
            row.get("request_id") != spoofed_id,
            repr(row.get("request_id")),
        )
        print(f"      (recorded ip_address={recorded}, request_id={row.get('request_id')})")
        # A response large enough for gzip (min length 1 KiB) must still come uncompressed (BREACH).
        listing = client.request(
            "GET",
            "/api/v1/audit-logs?page_size=50",
            headers={"Cookie": cookie, "Accept": "application/json", "Accept-Encoding": "gzip"},
        )
        report.check(
            f"API responses are not compressed ({len(listing.body)} bytes, Accept-Encoding: gzip)",
            listing.status == 200
            and len(listing.body) >= 1024
            and listing.header("content-encoding") is None,
            f"status {listing.status}, {len(listing.body)} bytes, "
            f"Content-Encoding {listing.header('content-encoding')!r}",
        )
    finally:
        client.request(
            "POST", "/api/v1/auth/logout", headers={"Cookie": cookie, "Origin": origin, "X-CSRF-Token": csrf}
        )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__.split("\n\n")[0], formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument(
        "--base-url", required=True, help="the public HTTPS origin, e.g. https://vms.example.com"
    )
    parser.add_argument(
        "--connect-to",
        help="connect to this address instead of resolving the host name (SNI and Host stay the name)",
    )
    parser.add_argument(
        "--cafile", help="CA bundle that issued the server certificate (default: the system store)"
    )
    parser.add_argument(
        "--insecure", action="store_true", help="do not verify the server certificate (test setups only)"
    )
    parser.add_argument(
        "--http-url", help="the plain HTTP origin (a name or an address), to check the redirect to HTTPS"
    )
    parser.add_argument(
        "--deep-link", action="append", default=[], help="another SPA route to check (repeatable)"
    )
    parser.add_argument(
        "--no-hsts",
        dest="expect_hsts",
        action="store_false",
        help="the API does not run with APP_ENV=production",
    )
    parser.add_argument(
        "--admin-email",
        help="SYSTEM_ADMIN account for the client-address check (password: VMS_SMOKE_PASSWORD)",
    )
    parser.add_argument(
        "--expect-client-ip", help="the address nginx sees for this client (for the client-address check)"
    )
    parser.add_argument("--source-address", help="local address to connect from")
    args = parser.parse_args(argv)
    started = time.monotonic()
    report = run(args)
    print(f"\n{report.passed} passed, {len(report.failures)} failed ({time.monotonic() - started:.1f} s)")
    return 1 if report.failures else 0


if __name__ == "__main__":
    sys.exit(main())
