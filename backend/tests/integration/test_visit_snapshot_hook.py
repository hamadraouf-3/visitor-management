"""D-17 hook: renaming a department or a user refreshes the snapshots of SCHEDULED visits in the same
transaction (`VisitSnapshotRefresher`, decision B1-51)."""

from datetime import datetime

import pytest
from fastapi import FastAPI
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.core import time as app_time
from app.models import Department, User, VisitStatus
from app.repositories.visits import VisitRepository
from app.services.visit_hooks import VisitSnapshots
from tests.support import Api, World


class RecordingRefresher:
    """Records each call together with what the database shows inside the caller's transaction."""

    def __init__(self, *, fail: bool = False) -> None:
        self.fail = fail
        self.calls: list[tuple[str, str, str]] = []

    def host_renamed(self, db: Session, *, host: User, now: datetime) -> int:
        stored = db.execute(text("SELECT full_name FROM users WHERE id = :id"), {"id": host.id}).scalar_one()
        self.calls.append(("host", str(host.id), stored))
        if self.fail:
            raise RuntimeError("snapshot refresh failed")
        return 0

    def department_renamed(self, db: Session, *, department: Department, now: datetime) -> int:
        stored = db.execute(
            text("SELECT name FROM departments WHERE id = :id"), {"id": department.id}
        ).scalar_one()
        self.calls.append(("department", str(department.id), stored))
        if self.fail:
            raise RuntimeError("snapshot refresh failed")
        return 0


@pytest.fixture
def refresher(app: FastAPI):
    recording = RecordingRefresher()
    original = app.state.visit_snapshot_refresher
    app.state.visit_snapshot_refresher = recording
    yield recording
    app.state.visit_snapshot_refresher = original


@pytest.fixture
def admin(client, world: World) -> Api:
    api = Api(client)
    assert api.login(world.a.admin.email).status_code == 200
    return api


def test_department_rename_refreshes_snapshots_in_the_same_transaction(
    admin: Api, world: World, refresher: RecordingRefresher
) -> None:
    response = admin.patch(f"/departments/{world.a.finance.id}", json={"name": "Treasury"})
    assert response.status_code == 200
    # Called once, after the rename was written (flushed) and before it was committed.
    assert refresher.calls == [("department", str(world.a.finance.id), "Treasury")]


def test_other_department_changes_do_not_refresh(
    admin: Api, world: World, refresher: RecordingRefresher
) -> None:
    assert admin.patch(f"/departments/{world.a.finance.id}", json={"is_active": False}).status_code == 200
    assert admin.patch(f"/departments/{world.a.finance.id}", json={"name": "Finance"}).status_code == 200
    assert refresher.calls == []


def test_user_rename_refreshes_host_snapshots(
    admin: Api, world: World, refresher: RecordingRefresher
) -> None:
    response = admin.patch(f"/users/{world.a.employee.id}", json={"full_name": "Renamed Host"})
    assert response.status_code == 200
    assert refresher.calls == [("host", str(world.a.employee.id), "Renamed Host")]
    assert admin.patch(f"/users/{world.a.employee.id}", json={"phone": "+962 79 111 2222"}).status_code == 200
    assert len(refresher.calls) == 1  # only name changes refresh


def test_a_failed_refresh_rolls_the_rename_back(app: FastAPI, admin: Api, world: World, db: Session) -> None:
    original = app.state.visit_snapshot_refresher
    app.state.visit_snapshot_refresher = RecordingRefresher(fail=True)
    try:
        response = admin.patch(f"/departments/{world.a.finance.id}", json={"name": "Treasury"})
    finally:
        app.state.visit_snapshot_refresher = original
    assert response.status_code == 500
    db.expire_all()
    assert db.get(Department, world.a.finance.id).name == "Finance"


def test_production_wiring_of_the_visit_snapshot_refresher(
    settings, app_engine, hasher, email_provider
) -> None:
    """D-17 must not depend on a test injecting the refresher: the factory wires the visit service's."""
    from app.main import create_app

    app = create_app(settings, engine=app_engine, password_hasher=hasher, email_provider=email_provider)
    assert isinstance(app.state.visit_snapshot_refresher, VisitSnapshots)


def test_an_arabic_rename_refreshes_snapshots_too(
    admin: Api, world: World, refresher: RecordingRefresher, db: Session
) -> None:
    """B10-25: the visits record the Arabic name as well, so a change of the Arabic name alone refreshes
    them; the same value again does not."""
    assert admin.patch(f"/departments/{world.a.finance.id}", json={"name_ar": "المالية"}).status_code == 200
    assert refresher.calls == [("department", str(world.a.finance.id), "Finance")]
    assert admin.patch(f"/departments/{world.a.finance.id}", json={"name_ar": "المالية"}).status_code == 200
    assert len(refresher.calls) == 1


def test_finished_visits_are_never_refreshed(db: Session, world: World) -> None:
    """The snapshot refresh cannot be pointed at checked-out or cancelled visits, which the database keeps
    immutable (`visits_terminal_immutable`)."""
    for status in (VisitStatus.CHECKED_OUT, VisitStatus.CANCELLED):
        with pytest.raises(ValueError, match="immutable"):
            VisitRepository(db).complete_department_names(
                world.a.company.id,
                world.a.finance.id,
                "Finance",
                "المالية",
                statuses=(VisitStatus.CHECKED_IN, status),
                now=app_time.now(),
            )
