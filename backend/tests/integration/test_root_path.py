"""Deployed under a path prefix (`uvicorn --root-path /vms`), every security decision must still apply.

ASGI servers put the prefix into both `root_path` and `path`; Starlette routes on the path without the
prefix. The CSRF/Origin middleware, the CSRF exemptions, the API response headers and the audited route
template therefore all use that same route path, or the checks fail open while the router still
dispatches the request.
"""

from collections.abc import Callable
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from tests.support import DEFAULT_PASSWORD, World, audit_rows, error_code

PREFIX = "/vms"
API = f"{PREFIX}/api/v1"


class MountedApi:
    def __init__(self, client: TestClient) -> None:
        self.client = client

    @property
    def csrf_token(self) -> str | None:
        return self.client.cookies.get("__Host-vms_csrf")

    def post(self, path: str, *, csrf: bool = True, headers: dict[str, str] | None = None, **kwargs: Any):
        merged = dict(headers or {})
        if csrf and self.csrf_token:
            merged["X-CSRF-Token"] = self.csrf_token
        return self.client.post(API + path, headers=merged, **kwargs)

    def get(self, path: str, **kwargs: Any) -> httpx.Response:
        return self.client.get(API + path, **kwargs)


@pytest.fixture
def mounted(make_client: Callable[..., TestClient], world: World) -> MountedApi:
    api = MountedApi(make_client(root_path=PREFIX))
    # The login exemption from the CSRF token check works under the prefix too.
    response = api.post("/auth/login", json={"email": world.a.admin.email, "password": DEFAULT_PASSWORD})
    assert response.status_code == 200
    return api


def test_missing_csrf_token_is_rejected_under_a_root_path(
    mounted: MountedApi, db: Session, world: World
) -> None:
    response = mounted.post("/departments", json={"name": "Security"}, csrf=False)
    assert response.status_code == 403
    assert error_code(response) == "CSRF_FAILED"
    [row] = audit_rows(db, "CSRF_FAILED")
    assert row.meta == {"reason": "token_mismatch", "method": "POST", "route": "/api/v1/departments"}
    assert row.actor_user_id == world.a.admin.id


@pytest.mark.parametrize(
    "headers",
    [
        {"Origin": "https://evil.example"},
        {"Sec-Fetch-Site": "cross-site"},
        {"Origin": "https://evil.example", "Sec-Fetch-Site": "cross-site"},
    ],
)
def test_foreign_origin_is_rejected_under_a_root_path(mounted: MountedApi, headers: dict[str, str]) -> None:
    response = mounted.post("/departments", json={"name": "Security"}, headers=headers)
    assert response.status_code == 403
    assert error_code(response) == "CSRF_FAILED"


def test_valid_requests_still_work_under_a_root_path(mounted: MountedApi) -> None:
    assert mounted.post("/departments", json={"name": "Security"}).status_code == 201


def test_api_headers_are_sent_under_a_root_path(mounted: MountedApi) -> None:
    response = mounted.get("/health")
    assert response.status_code == 200
    assert response.headers["Cache-Control"] == "no-store"
    assert response.headers["Content-Security-Policy"].startswith("default-src 'none'")
    assert response.headers["Cross-Origin-Resource-Policy"] == "same-origin"


def test_unprefixed_paths_are_checked_as_well(make_client: Callable[..., TestClient], world: World) -> None:
    # Requests whose path lacks the prefix are routed by Starlette too, so they must be checked too.
    client = make_client(root_path=PREFIX)
    login = client.post(
        "/api/v1/auth/login", json={"email": world.a.admin.email, "password": DEFAULT_PASSWORD}
    )
    assert login.status_code == 200
    response = client.post("/api/v1/departments", json={"name": "Security"})
    assert response.status_code == 403
    assert error_code(response) == "CSRF_FAILED"
