"""What reaches the logs from database errors and client-chosen names (SEC-11, SEC-19)."""

import json
import logging

import pytest
from fastapi import APIRouter, FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.core.logging import EXCEPTION_DETAIL_REDACTED, JsonFormatter, TextFormatter
from app.db.session import session_factory
from app.main import create_app
from app.models import User
from tests.support import Api, World

PRIVATE_NAME = "Zainab Secretname"


def _duplicate_of(user: User) -> User:
    return User(
        company_id=user.company_id,
        full_name=PRIVATE_NAME,
        email=user.email,
        password_hash=user.password_hash,
        roles=["EMPLOYEE"],
    )


def _insert(db: Session, row: User) -> None:
    db.add(row)
    db.flush()


def _formatted(records: list[logging.LogRecord]) -> list[str]:
    return [
        formatter.format(record) for record in records for formatter in (JsonFormatter(), TextFormatter())
    ]


def test_formatted_database_errors_show_no_row_values(db: Session, world: World) -> None:
    """The DETAIL of a unique violation quotes the key (`Key (email)=(…)`); a NOT NULL or CHECK violation
    quotes the whole row (`Failing row contains (…)`). Neither reaches a formatted exception."""
    taken = world.a.employee
    logger = logging.getLogger("app.test")
    records: list[logging.LogRecord] = []
    handler = logging.Handler()
    handler.emit = records.append  # type: ignore[method-assign]
    logger.addHandler(handler)
    try:
        for row in (_duplicate_of(taken), User(company_id=taken.company_id, full_name=PRIVATE_NAME)):
            with pytest.raises(IntegrityError) as caught, db.begin_nested():
                _insert(db, row)
            assert "DETAIL" in str(caught.value)  # the driver message does carry it
            try:
                raise caught.value
            except IntegrityError:
                logger.exception("failed")
    finally:
        logger.removeHandler(handler)
    assert len(records) == 2
    for text in _formatted(records):
        assert taken.email not in text and PRIVATE_NAME not in text
        assert EXCEPTION_DETAIL_REDACTED in text


@pytest.fixture
def constraint_app(settings: Settings, app_engine, hasher, email_provider, connection) -> FastAPI:
    app = create_app(settings, engine=app_engine, password_hasher=hasher, email_provider=email_provider)
    router = APIRouter()

    @router.get("/api/v1/duplicate/{email}")
    def duplicate(email: str) -> None:
        with session_factory() as db:
            template = db.query(User).filter(User.email == email).one()
            db.add(_duplicate_of(template))
            db.flush()

    app.include_router(router)
    return app


def test_an_unmapped_constraint_violation_is_logged_without_its_values(
    constraint_app: FastAPI, world: World, caplog: pytest.LogCaptureFixture
) -> None:
    client = TestClient(constraint_app, base_url="https://testserver")
    with caplog.at_level(logging.ERROR, logger="app.middleware"):
        response = client.get(f"/api/v1/duplicate/{world.a.employee.email}")
    assert response.status_code == 500
    (record,) = [r for r in caplog.records if r.name == "app.middleware"]
    assert record.exc_info  # operators still get the traceback
    assert (record.db_error, record.sqlstate, record.constraint) == (
        "UniqueViolation",
        "23505",
        "uq_users_email",
    )
    for text in _formatted([record]):
        assert world.a.employee.email not in text and PRIVATE_NAME not in text


def test_logged_validation_locations_are_bounded_and_inert(
    client: TestClient, caplog: pytest.LogCaptureFixture
) -> None:
    """An unknown body key is the client's own text: the log keeps a short, escaped prefix of it."""
    key = "\u009b2J\u2028" + "k" * 5000
    with caplog.at_level(logging.INFO, logger="app.errors"):
        response = Api(client).post(
            "/auth/login", json={"email": "a@b.c", "password": "x", key: 1}, csrf=False
        )
    assert response.status_code == 422
    (record,) = [r for r in caplog.records if r.getMessage() == "request validation failed"]
    line = JsonFormatter().format(record)
    assert len(line) < 1000
    assert "\u009b" not in line and "\u2028" not in line
    (location,) = [error["loc"] for error in json.loads(line)["validation_errors"]]
    assert location[0] == "body" and location[1].startswith("\u009b2J\u2028kkk")
