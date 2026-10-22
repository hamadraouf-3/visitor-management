"""BodySizeLimitMiddleware: oversized API bodies answer 413 PAYLOAD_TOO_LARGE, whether the size is
declared up front, missing, or wrong; and the one route with a limit of its own (the upload of a company's
brand image, B12-6) is exactly that route."""

import json
import re
import uuid

import anyio
import pytest
from fastapi import FastAPI, Request
from fastapi.routing import APIRoute, iter_route_contexts
from pydantic import BaseModel
from starlette.routing import compile_path

from app.api.routes import api_router
from app.api.routes.platform import (
    BRAND_IMAGE_UPLOAD_MAX_BYTES,
    BRAND_IMAGE_UPLOAD_METHOD,
    BRAND_IMAGE_UPLOAD_PATH,
)
from app.core.errors import register_exception_handlers
from app.core.middleware import BodyLimit, BodySizeLimitMiddleware

LIMIT = 1024
UPLOAD_LIMIT = 8 * LIMIT


class _Body(BaseModel):
    text: str


def _app() -> BodySizeLimitMiddleware:
    app = FastAPI()
    register_exception_handlers(app)
    calls: list[int] = []

    @app.post("/api/v1/echo")
    def echo(body: _Body) -> dict[str, int]:
        calls.append(len(body.text))
        return {"length": len(body.text)}

    @app.post("/outside")
    def outside(body: _Body) -> dict[str, int]:
        return {"length": len(body.text)}

    wrapped = BodySizeLimitMiddleware(app, max_body_bytes=LIMIT)
    wrapped.calls = calls  # type: ignore[attr-defined]
    return wrapped


async def _call(
    app: BodySizeLimitMiddleware,
    path: str,
    chunks: list[bytes],
    declared: int | None,
    method: str = "POST",
    root_path: str = "",
) -> tuple[int, dict, int]:
    headers = [(b"content-type", b"application/json")]
    if declared is not None:
        headers.append((b"content-length", str(declared).encode()))
    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": method,
        "scheme": "https",
        "path": root_path + path,
        "raw_path": (root_path + path).encode(),
        "root_path": root_path,
        "query_string": b"",
        "headers": headers,
        "client": ("203.0.113.10", 50000),
        "server": ("testserver", 443),
    }
    pending = [
        {"type": "http.request", "body": chunk, "more_body": index < len(chunks) - 1}
        for index, chunk in enumerate(chunks)
    ]
    received = 0

    async def receive() -> dict:
        nonlocal received
        if pending:
            message = pending.pop(0)
            received += len(message["body"])
            return message
        return {"type": "http.disconnect"}

    sent: list[dict] = []

    async def send(message: dict) -> None:
        sent.append(message)

    await app(scope, receive, send)
    [start] = [message for message in sent if message["type"] == "http.response.start"]
    body = b"".join(message.get("body", b"") for message in sent if message["type"] == "http.response.body")
    return start["status"], json.loads(body), received


def _payload(size: int) -> bytes:
    return json.dumps({"text": "x" * size}).encode()


def test_small_bodies_pass() -> None:
    status, body, _ = anyio.run(_call, _app(), "/api/v1/echo", [_payload(100)], len(_payload(100)))
    assert status == 200 and body == {"length": 100}


def test_declared_length_over_the_limit_is_refused_unread() -> None:
    app = _app()
    status, body, received = anyio.run(_call, app, "/api/v1/echo", [_payload(5000)], 5000)
    assert status == 413
    assert body["error"] == {
        "code": "PAYLOAD_TOO_LARGE",
        "message": "The request is too large.",
        "details": {},
    }
    assert received == 0 and app.calls == []  # type: ignore[attr-defined]


@pytest.mark.parametrize("declared", [None, 10])  # no Content-Length, or one that lies
def test_streamed_bodies_are_counted(declared: int | None) -> None:
    app = _app()
    payload = _payload(4000)
    chunks = [payload[i : i + 500] for i in range(0, len(payload), 500)]
    status, body, received = anyio.run(_call, app, "/api/v1/echo", chunks, declared)
    assert status == 413 and body["error"]["code"] == "PAYLOAD_TOO_LARGE"
    assert received <= LIMIT + 500  # reading stopped at the first chunk past the limit
    assert app.calls == []  # type: ignore[attr-defined]


def test_only_api_paths_are_limited() -> None:
    status, _, _ = anyio.run(_call, _app(), "/outside", [_payload(5000)], None)
    assert status == 200


# ---- a route with a limit of its own (B12-6) -----------------------------------------------------------

UPLOAD = "/api/v1/things/7/image"


def _upload_app(limit: int = UPLOAD_LIMIT) -> BodySizeLimitMiddleware:
    """An upload route (the raw body is the file) beside routes that are not it."""
    app = FastAPI()
    register_exception_handlers(app)

    async def length(request: Request) -> dict[str, int]:
        return {"length": len(await request.body())}

    app.put("/api/v1/things/{thing}/image")(length)
    app.post("/api/v1/things/{thing}/image")(length)
    app.put("/api/v1/things/{thing}/image/{more}")(length)
    app.put("/api/v1/things/{thing}")(length)
    return BodySizeLimitMiddleware(
        app,
        max_body_bytes=LIMIT,
        route_limits=(BodyLimit("PUT", re.compile(r"/api/v1/things/[^/]+/image"), limit),),
    )


@pytest.mark.parametrize("declared", [5000, None], ids=["declared", "streamed"])
def test_a_route_with_its_own_limit_takes_a_larger_body(declared: int | None) -> None:
    body = b"x" * 5000  # above the limit of every other request
    chunks = [body[i : i + 700] for i in range(0, len(body), 700)]
    status, answer, received = anyio.run(_call, _upload_app(), UPLOAD, chunks, declared, "PUT")
    assert status == 200 and answer == {"length": 5000} and received == 5000


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("POST", UPLOAD),  # the same path, another method
        ("PUT", UPLOAD + "/extra"),  # a longer path
        ("PUT", "/api/v1/things/7"),  # a shorter one
    ],
)
@pytest.mark.parametrize("declared", [5000, None], ids=["declared", "streamed"])
def test_no_other_request_gains_the_larger_limit(method: str, path: str, declared: int | None) -> None:
    status, answer, _ = anyio.run(_call, _upload_app(), path, [b"x" * 5000], declared, method)
    assert status == 413 and answer["error"]["code"] == "PAYLOAD_TOO_LARGE"


@pytest.mark.parametrize("declared", [UPLOAD_LIMIT + 1, None, 10], ids=["declared", "streamed", "lying"])
def test_the_route_s_own_limit_is_still_a_limit(declared: int | None) -> None:
    body = b"x" * (UPLOAD_LIMIT + 1)
    chunks = [body[i : i + 1000] for i in range(0, len(body), 1000)]
    status, answer, received = anyio.run(_call, _upload_app(), UPLOAD, chunks, declared, "PUT")
    assert status == 413 and answer["error"]["code"] == "PAYLOAD_TOO_LARGE"
    assert received <= UPLOAD_LIMIT + 1000
    if declared == UPLOAD_LIMIT + 1:
        assert received == 0  # refused unread
    # Exactly the limit passes.
    status, answer, _ = anyio.run(_call, _upload_app(), UPLOAD, [b"x" * UPLOAD_LIMIT], UPLOAD_LIMIT, "PUT")
    assert status == 200 and answer == {"length": UPLOAD_LIMIT}


def test_a_route_s_own_limit_may_be_smaller_than_the_default() -> None:
    app = _upload_app(limit=100)
    status, _, _ = anyio.run(_call, app, UPLOAD, [b"x" * 101], 101, "PUT")
    assert status == 413
    status, _, _ = anyio.run(_call, app, UPLOAD, [b"x" * 100], 100, "PUT")
    assert status == 200


def test_the_route_is_recognised_by_the_path_the_router_sees() -> None:
    """Behind a proxy that mounts the API under a prefix (`--root-path`), the limit is decided on the
    route path like every other check: the prefix neither hides the upload route nor makes another one
    look like it."""
    app = _upload_app()
    status, _, _ = anyio.run(_call, app, UPLOAD, [b"x" * 5000], 5000, "PUT", "/vms")
    assert status == 200
    status, _, _ = anyio.run(_call, app, "/api/v1/things/7", [b"x" * 5000], 5000, "PUT", "/vms")
    assert status == 413


# ---- the application's own route limit ----------------------------------------------------------------


def _routes(method: str) -> dict[str, re.Pattern[str]]:
    """Every API route of `method`: its full template and the pattern the router matches paths with."""
    found: dict[str, re.Pattern[str]] = {}
    for context in iter_route_contexts(api_router.routes):
        route = context.original_route
        if isinstance(route, APIRoute) and method in route.methods:
            found[context.path] = compile_path(context.path)[0]
    return found


def test_the_brand_image_upload_is_the_one_request_with_a_limit_of_its_own() -> None:
    assert (BRAND_IMAGE_UPLOAD_METHOD, BRAND_IMAGE_UPLOAD_MAX_BYTES) == ("PUT", 512 * 1024)
    template = "/api/v1/platform/companies/{company_id}/brand/assets/{kind}"
    puts = _routes("PUT")
    # The only PUT of the API with a limit of its own, and the pattern matches what its route matches. The
    # provider's ingestion path answers every method but POST with 404 or 405 before reading anything
    # (Phase 15, B15-38); a visit's allowed areas (Phase 16, B16-2) are a small JSON body, under the
    # API's default limit like every other.
    assert sorted(puts) == sorted(
        [template, "/api/v1/tracking/events", "/api/v1/visits/{visit_id}/access-areas"]
    )
    company = uuid.uuid4()
    for kind in ("logo", "logo_dark", "icon", "anything"):
        path = f"/api/v1/platform/companies/{company}/brand/assets/{kind}"
        assert BRAND_IMAGE_UPLOAD_PATH.fullmatch(path) and puts[template].match(path)
    # No other path of the API is the upload: every other route template, filled in, is refused the
    # larger limit (whatever its method).
    others = [
        template
        for method in ("GET", "POST", "PATCH", "DELETE", "PUT")
        for template in _routes(method)
        if template != "/api/v1/platform/companies/{company_id}/brand/assets/{kind}"
    ]
    assert len(others) > 60
    for other in others:
        assert not BRAND_IMAGE_UPLOAD_PATH.fullmatch(re.sub(r"{[^}]+}", "x", other)), other


@pytest.mark.parametrize(
    "path",
    [
        "/api/v1/platform/companies/x/brand/assets",
        "/api/v1/platform/companies/x/brand/assets/",
        "/api/v1/platform/companies/x/brand/assets/logo/",
        "/api/v1/platform/companies/x/brand/assets/logo/extra",
        "/api/v1/platform/companies/x/y/brand/assets/logo",
        "/api/v1/platform/companies//brand/assets/logo",
        "/api/v1/platform/companies/x/brand",
        "/api/v1/companies/x/brand/assets/logo",
        "/api/v1/public/companies/x/brand/assets/logo",
        "/x/api/v1/platform/companies/x/brand/assets/logo",
        "/API/V1/platform/companies/x/brand/assets/logo",
    ],
)
def test_nothing_else_is_the_brand_image_upload(path: str) -> None:
    assert not BRAND_IMAGE_UPLOAD_PATH.fullmatch(path)
