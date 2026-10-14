"""Verifies, against the installed FastAPI, that `Depends(get_db, scope="function")` finishes its cleanup
(rollback/close) before background tasks run (contract §3.2-1)."""

from typing import Annotated

from fastapi import BackgroundTasks, Depends, FastAPI
from fastapi.testclient import TestClient

from app.db import session as db_session


class RecordingSession:
    def __init__(self, events: list[str]) -> None:
        self.events = events
        self.open_transaction = True

    def in_transaction(self) -> bool:
        return self.open_transaction

    def rollback(self) -> None:
        self.events.append("rollback")
        self.open_transaction = False

    def close(self) -> None:
        self.events.append("close")


def _app(events: list[str], scope: str | None) -> FastAPI:
    app = FastAPI()
    dependency = Depends(db_session.get_db, scope=scope) if scope else Depends(db_session.get_db)

    @app.post("/work")
    def work(db: Annotated[RecordingSession, dependency], background_tasks: BackgroundTasks) -> dict:
        events.append("endpoint")
        background_tasks.add_task(lambda: events.append("background"))
        return {}

    return app


def _run(monkeypatch, scope: str | None) -> list[str]:
    events: list[str] = []
    monkeypatch.setattr(db_session, "session_factory", lambda: RecordingSession(events))
    response = TestClient(_app(events, scope)).post("/work")
    assert response.status_code == 200
    return events


def test_function_scope_cleans_up_before_background_tasks(monkeypatch) -> None:
    assert _run(monkeypatch, "function") == ["endpoint", "rollback", "close", "background"]


def test_default_scope_would_clean_up_after_background_tasks(monkeypatch) -> None:
    """Documents why the explicit scope is needed with this FastAPI version."""
    assert _run(monkeypatch, None) == ["endpoint", "background", "rollback", "close"]


def test_application_declares_function_scope() -> None:
    from app.api.deps import DbSession

    dependency = DbSession.__metadata__[0]
    assert dependency.dependency is db_session.get_db
    assert dependency.scope == "function"
