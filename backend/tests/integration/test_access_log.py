"""The access log (readiness round 1): which tenant, user and endpoint a request was, and how long its
response took, not counting the background work that runs after it (e-mail delivery)."""

import logging
import time
import uuid

import pytest
from fastapi import APIRouter, BackgroundTasks, FastAPI
from fastapi.testclient import TestClient

from app.core.config import Settings
from app.main import create_app
from tests.support import TEST_CLIENT_ADDRESS, Api, World, signed_in

BACKGROUND_SECONDS = 1.0


def _access(caplog: pytest.LogCaptureFixture) -> list[logging.LogRecord]:
    return [record for record in caplog.records if record.name == "app.access"]


def test_access_lines_name_the_user_company_and_route_template(
    make_client, world: World, caplog: pytest.LogCaptureFixture
) -> None:
    employee = signed_in(make_client, world.a.employee)
    missing = uuid.uuid4()
    with caplog.at_level(logging.INFO, logger="app.access"):
        employee.get(f"/visits/{missing}")
        Api(make_client()).get("/auth/me")  # nobody signed in

    signed, anonymous = _access(caplog)
    assert signed.path == f"/api/v1/visits/{missing}" and signed.route == "/api/v1/visits/{visit_id}"
    assert signed.status == 404
    assert (signed.user_id, signed.company_id) == (str(world.a.employee.id), str(world.a.company.id))
    assert anonymous.route == "/api/v1/auth/me" and anonymous.status == 401
    assert (anonymous.user_id, anonymous.company_id) == (None, None)


def test_an_unknown_path_is_logged_as_unmatched(client: TestClient, caplog: pytest.LogCaptureFixture) -> None:
    with caplog.at_level(logging.INFO, logger="app.access"):
        client.get("/api/v1/no-such-endpoint/12345")
    (line,) = _access(caplog)
    assert (line.route, line.status) == ("unmatched", 404)


@pytest.fixture
def background_app(settings: Settings, app_engine, hasher, email_provider) -> FastAPI:
    app = create_app(settings, engine=app_engine, password_hasher=hasher, email_provider=email_provider)
    router = APIRouter()

    def slow_background_work() -> None:
        time.sleep(BACKGROUND_SECONDS)
        logging.getLogger("app.email").info("background work done")

    @router.post("/api/v1/test-background", status_code=202)
    def schedule(background_tasks: BackgroundTasks) -> dict[str, str]:
        background_tasks.add_task(slow_background_work)
        return {"status": "accepted"}

    app.include_router(router)
    return app


def test_the_response_time_excludes_background_work(
    background_app: FastAPI, caplog: pytest.LogCaptureFixture
) -> None:
    client = TestClient(background_app, base_url="https://testserver", client=TEST_CLIENT_ADDRESS)
    with caplog.at_level(logging.INFO):
        started = time.perf_counter()
        assert client.post("/api/v1/test-background").status_code == 202
        elapsed_ms = (time.perf_counter() - started) * 1000  # the client waits for the background work too

    (line,) = _access(caplog)
    assert line.status == 202
    # The response, not the e-mail after it: the logged time leaves the background work out. Measured
    # against the call's own time rather than a fixed bound, which a loaded machine's response exceeded.
    assert elapsed_ms - line.duration_ms >= BACKGROUND_SECONDS * 1000 * 0.9
    order = [record.getMessage() for record in caplog.records if record.name in {"app.access", "app.email"}]
    assert order == ["request", "background work done"]  # written when the response was sent
