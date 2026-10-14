"""Reading the body of a brand image upload (`app.api.deps.read_png_upload`, B12-6 and B12-18).

nginx passes this one body on while it arrives, so the API meets what nginx used to absorb: a body that
trickles in, and a sender that goes away. Nothing of a body is read for a caller who is not signed in or
did not send a PNG; a body that is read has all of 30 seconds to arrive; and one whose sender went away
is an ordinary refused request, not an unhandled error.

Raw ASGI calls, so the body arrives exactly as each test says: in pieces, late, or never.
"""

import json
from collections.abc import Awaitable, Callable

import anyio
import pytest
from fastapi import FastAPI

from app.api import deps
from app.api.deps import PngUpload, get_current_platform_auth
from app.api.routes.platform import (
    BRAND_IMAGE_UPLOAD_MAX_BYTES,
    BRAND_IMAGE_UPLOAD_METHOD,
    BRAND_IMAGE_UPLOAD_PATH,
)
from app.core.errors import NotAuthenticated, register_exception_handlers
from app.core.middleware import BodyLimit, BodySizeLimitMiddleware

UPLOAD = "/api/v1/platform/companies/3f0d3c7e-9d0a-4c56-8a51-0a3b6c1d2e4f/brand/assets/logo"
PNG = "image/png"
# What a test waits for an answer at the most: an upload that is never answered fails, it does not hang.
PATIENCE = 10.0
Receive = Callable[[], Awaitable[dict]]


def _app(*, signed_in: bool = True) -> BodySizeLimitMiddleware:
    """The upload's route as the application declares it (the same dependency, the same body limit),
    with the platform owner's session replaced by a switch."""
    app = FastAPI()
    register_exception_handlers(app)

    def platform_auth() -> None:
        if not signed_in:
            raise NotAuthenticated()

    app.dependency_overrides[get_current_platform_auth] = platform_auth

    @app.put("/api/v1/platform/companies/{company_id}/brand/assets/{kind}")
    def upload(company_id: str, kind: str, body: PngUpload) -> dict[str, int]:
        return {"length": len(body)}

    return BodySizeLimitMiddleware(
        app,
        max_body_bytes=1024,
        route_limits=(
            BodyLimit(BRAND_IMAGE_UPLOAD_METHOD, BRAND_IMAGE_UPLOAD_PATH, BRAND_IMAGE_UPLOAD_MAX_BYTES),
        ),
    )


class _Body:
    """A request body as the server hands it to the application: `pieces` one after the other, then
    `then` ("end": the body is complete; "stall": nothing more ever arrives; "disconnect": the sender
    went away; "trickle": one more byte every few milliseconds, for ever)."""

    def __init__(self, pieces: list[bytes], then: str = "end") -> None:
        self.pieces = list(pieces)
        self.then = then
        self.asked = 0  # how often the application asked for more of the body

    async def receive(self) -> dict:
        self.asked += 1
        if self.pieces:
            piece = self.pieces.pop(0)
            return {
                "type": "http.request",
                "body": piece,
                "more_body": bool(self.pieces) or self.then != "end",
            }
        if self.then == "trickle":
            await anyio.sleep(0.005)
            return {"type": "http.request", "body": b"x", "more_body": True}
        if self.then == "stall":
            await anyio.sleep_forever()
        return {"type": "http.disconnect"}


async def _put(
    app: BodySizeLimitMiddleware, body: _Body, content_type: str = PNG, declared: int | None = None
) -> tuple[int, dict]:
    headers = [(b"content-type", content_type.encode())]
    if declared is not None:
        headers.append((b"content-length", str(declared).encode()))
    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "PUT",
        "scheme": "https",
        "path": UPLOAD,
        "raw_path": UPLOAD.encode(),
        "root_path": "",
        "query_string": b"",
        "headers": headers,
        "client": ("203.0.113.10", 50000),
        "server": ("testserver", 443),
    }
    sent: list[dict] = []

    async def send(message: dict) -> None:
        sent.append(message)

    with anyio.fail_after(PATIENCE):
        await app(scope, body.receive, send)
    [start] = [message for message in sent if message["type"] == "http.response.start"]
    answer = b"".join(message.get("body", b"") for message in sent if message["type"] == "http.response.body")
    return start["status"], json.loads(answer)


def _error(answer: dict) -> tuple[str, str]:
    return answer["error"]["code"], answer["error"]["message"]


def test_a_body_that_arrives_in_pieces_is_read_whole() -> None:
    body = _Body([b"\x89PNG", b"\r\n\x1a\n", b"x" * 70_000])
    status, answer = anyio.run(_put, _app(), body)
    assert (status, answer) == (200, {"length": 70_008})


@pytest.mark.parametrize("then", ["stall", "trickle"])
def test_a_body_has_thirty_seconds_to_arrive_all_of_it(monkeypatch: pytest.MonkeyPatch, then: str) -> None:
    """The time is for the whole body, not between two pieces of it (which is all nginx's own timeout
    bounds): a body that keeps arriving a byte at a time is answered 408 as one that stopped is."""
    assert deps.PNG_UPLOAD_SECONDS == 30.0
    monkeypatch.setattr(deps, "PNG_UPLOAD_SECONDS", 0.2)
    body = _Body([b"\x89PNG\r\n\x1a\n"], then=then)
    status, answer = anyio.run(_put, _app(), body, PNG, 500_000)
    assert status == 408
    # No code of its own: every 4xx outside the contract's list is a BAD_REQUEST, told apart by its status.
    assert _error(answer) == ("BAD_REQUEST", "The upload did not arrive in time. Please try again.")
    assert answer["error"]["details"] == {}


def test_a_sender_that_goes_away_is_an_ordinary_refusal() -> None:
    """Not an unhandled error with a traceback in the log: the body ended early, as a JSON body can."""
    body = _Body([b"\x89PNG\r\n\x1a\n"], then="disconnect")
    status, answer = anyio.run(_put, _app(), body, PNG, 500_000)
    assert status == 400
    assert _error(answer) == ("BAD_REQUEST", "The upload was interrupted. Please try again.")


@pytest.mark.parametrize("then", ["stall", "trickle", "end"])
def test_nothing_of_a_body_is_read_for_someone_who_is_not_signed_in(then: str) -> None:
    """The answer does not wait for the body, whatever the body does: this is what lets nginx hand the
    request over before the body arrived, and a stranger's request end at once (B12-18)."""
    body = _Body([b"\x89PNG\r\n\x1a\n"], then=then)
    status, answer = anyio.run(_put, _app(signed_in=False), body, PNG, 500_000)
    assert (status, answer["error"]["code"]) == (401, "NOT_AUTHENTICATED")
    assert body.asked == 0


def test_nothing_of_a_body_is_read_that_is_not_sent_as_a_png() -> None:
    body = _Body([b"<html>"], then="stall")
    status, answer = anyio.run(_put, _app(), body, "text/html", 500_000)
    assert (status, answer["error"]["code"]) == (415, "UNSUPPORTED_MEDIA_TYPE")
    assert body.asked == 0


def test_a_declared_length_above_the_limit_is_refused_before_anyone_is_asked_who_they_are() -> None:
    body = _Body([b"x"], then="stall")
    status, answer = anyio.run(_put, _app(signed_in=False), body, PNG, BRAND_IMAGE_UPLOAD_MAX_BYTES + 1)
    assert (status, answer["error"]["code"]) == (413, "PAYLOAD_TOO_LARGE")
    assert body.asked == 0


def test_a_body_without_a_declared_length_is_counted_while_it_is_read() -> None:
    """nginx passes a chunked upload on as it is, without a length: the API's own count is the limit."""
    piece = b"x" * (64 * 1024)
    whole = _Body([piece] * 8)  # exactly 512 KiB
    assert anyio.run(_put, _app(), whole) == (200, {"length": BRAND_IMAGE_UPLOAD_MAX_BYTES})
    over = _Body([piece] * 8 + [b"x"], then="stall")
    status, answer = anyio.run(_put, _app(), over)
    assert (status, answer["error"]["code"]) == (413, "PAYLOAD_TOO_LARGE")
