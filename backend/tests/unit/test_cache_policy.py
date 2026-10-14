"""Which API answers may be kept by a browser or a cache (Phase 12, B12-9): none, except what a route of
the public identity endpoints says about its own successful answer. Everywhere else `no-store` is written
over whatever a route set, so no answer to a signed-in person can ever be marked cacheable by mistake."""

import pytest
from fastapi import FastAPI, HTTPException, Response
from fastapi.testclient import TestClient

from app.core.config import Settings
from app.core.errors import register_exception_handlers
from app.core.middleware import RequestContextMiddleware

YEAR = "public, max-age=31536000, immutable"
SANDBOX = "default-src 'none'; sandbox"
API_POLICY = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"


def _client(root_path: str = "") -> TestClient:
    app = FastAPI()
    register_exception_handlers(app)

    def cacheable() -> Response:
        return Response(b"x", media_type="image/png", headers={"Cache-Control": YEAR, "ETag": '"x"'})

    def plain() -> dict[str, str]:
        return {"x": "y"}

    def missing() -> Response:
        raise HTTPException(status_code=404, headers={"Cache-Control": YEAR})

    def own_policy() -> Response:
        return Response(b"x", headers={"Content-Security-Policy": SANDBOX, "Cache-Control": YEAR})

    for path in (
        "/api/v1/public/companies/acme/brand/logo.png",
        "/api/v1/public",  # the prefix itself is no endpoint of the public group
        "/api/v1/publicity",
        "/api/v1/platform/public/x",
        "/api/v1/auth/me",
        "/api/v1/visits",
        "/api/v2/public/x",
        "/api/v1/Public/x",
    ):
        app.get(path)(cacheable)
    app.get("/api/v1/public/plain")(plain)
    app.get("/api/v1/public/missing")(missing)
    app.get("/api/v1/public/policy")(own_policy)
    app.get("/api/v1/policy")(own_policy)
    settings = Settings(
        _env_file=None,  # type: ignore[call-arg]
        app_env="test",
        database_url="postgresql://u:p@h/d",
    )
    app.add_middleware(RequestContextMiddleware, settings=settings)
    return TestClient(app, root_path=root_path)


def test_a_public_identity_route_says_how_long_its_answer_may_be_kept() -> None:
    response = _client().get("/api/v1/public/companies/acme/brand/logo.png")
    assert response.status_code == 200
    assert response.headers["Cache-Control"] == YEAR
    assert response.headers["ETag"] == '"x"'
    # Every other header of the API is still there.
    assert response.headers["X-Content-Type-Options"] == "nosniff"
    assert response.headers["X-Frame-Options"] == "DENY"
    assert response.headers["Cross-Origin-Resource-Policy"] == "same-origin"


@pytest.mark.parametrize(
    "path",
    [
        "/api/v1/auth/me",
        "/api/v1/visits",
        "/api/v1/platform/public/x",  # "public" somewhere in the path is not the public group
        "/api/v1/publicity",
        "/api/v1/public",
        "/api/v2/public/x",
        "/api/v1/Public/x",
    ],
)
def test_no_other_route_can_mark_its_answer_cacheable(path: str) -> None:
    response = _client().get(path)
    assert response.status_code == 200
    if path.startswith("/api/v1/"):
        assert response.headers["Cache-Control"] == "no-store", path
        assert response.headers.get_list("Cache-Control") == ["no-store"]  # replaced, not added to
    else:
        # Outside the API's prefix nothing of the API's headers applies; no route lives there.
        assert response.headers["Cache-Control"] == YEAR


def test_a_public_route_that_says_nothing_is_not_stored() -> None:
    response = _client().get("/api/v1/public/plain")
    assert response.status_code == 200 and response.headers["Cache-Control"] == "no-store"


def test_an_error_of_a_public_route_is_never_stored() -> None:
    """Whatever raised it, and whatever headers the error carried: the envelope is written by the error
    handler, and a missing company may exist tomorrow."""
    client = _client()
    for path in ("/api/v1/public/missing", "/api/v1/public/no-such-route", "/api/v1/public/companies"):
        response = client.get(path)
        assert response.status_code == 404
        assert response.headers.get_list("Cache-Control") == ["no-store"], path
    wrong_method = client.post("/api/v1/public/plain")
    assert wrong_method.status_code == 405 and wrong_method.headers["Cache-Control"] == "no-store"


def test_the_rule_follows_the_path_the_router_sees() -> None:
    """Behind a proxy that mounts the API under a prefix (`--root-path`), the public group is still the
    public group, and nothing else becomes it."""
    client = _client(root_path="/vms")
    assert client.get("/api/v1/public/companies/acme/brand/logo.png").headers["Cache-Control"] == YEAR
    assert client.get("/api/v1/visits").headers["Cache-Control"] == "no-store"


def test_a_route_s_own_content_policy_is_kept_everywhere_and_its_caching_rule_only_in_public() -> None:
    client = _client()
    public = client.get("/api/v1/public/policy")
    assert public.headers["Content-Security-Policy"] == SANDBOX and public.headers["Cache-Control"] == YEAR
    private = client.get("/api/v1/policy")
    assert private.headers["Content-Security-Policy"] == SANDBOX  # the e-mail preview documents (B11-28)
    assert private.headers["Cache-Control"] == "no-store"
    assert client.get("/api/v1/public/plain").headers["Content-Security-Policy"] == API_POLICY
