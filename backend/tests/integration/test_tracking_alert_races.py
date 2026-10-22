"""Area alerts on real, separately committing connections (Phase 16, B16-6, B16-7): two batches for the
same visit never make two active alerts (the second waits for the first's association lock, then moves the
first's alert on), and a batch that holds its association while it opens an alert neither deadlocks with a
check-out nor with a change of the visit's allowed areas: each locks the association before the alert, and
waits for the batch."""

import threading
import uuid
from datetime import timedelta
from typing import Any

import pytest
from pydantic import TypeAdapter
from sqlalchemy import Engine, select, text
from sqlalchemy.orm import Session, sessionmaker

from app.core.request_context import SYSTEM_CONTEXT
from app.models import TrackingAlert, User, VisitAccessArea
from app.schemas.locations import VisitAccessAreasInput
from app.schemas.visits import CheckOutRequest
from app.services.attendance import AttendanceService
from app.services.tracking_alerts import AlertMailer, TrackingAlerts
from app.services.tracking_ingestion import TrackingIngestion
from app.services.tracking_lifecycle import TrackingLifecycle
from app.services.tracking_provider import IncomingEvent
from app.services.tracking_rules import IngestEventType, IngestResult, RejectReason
from app.services.visits import VisitsService
from tests.conftest import TEST_START
from tests.integration.test_tracking_races import (
    WAIT,
    Enrolled,
    _backend_pid,
    _enrolled,
    _Threads,
    _waits_for_a_lock,
)
from tests.support import live_auth, service_environment
from tests.tracking_support import RecordingProvider

pytestmark = pytest.mark.committed


def _allowed_on_the_ground_floor(
    maker: sessionmaker[Session], enrolled: Enrolled
) -> tuple[uuid.UUID, uuid.UUID]:
    """Give the enrolled visit the ground floor as its allowed area (the registry's upper floor is then a
    violation); returns (visit ID, ground floor ID, upper floor ID)."""
    with maker() as db:
        visit_id, ground_id = db.execute(
            text(
                "SELECT a.visit_id, f.id FROM tracking_associations a JOIN floors f "
                "ON f.company_id = a.company_id AND f.level = 0 WHERE a.ref = :ref"
            ),
            {"ref": enrolled.ref},
        ).one()
        db.add(VisitAccessArea(company_id=enrolled.company_id, visit_id=visit_id, floor_id=ground_id))
        db.commit()
        return visit_id, ground_id


def _sighting(enrolled: Enrolled, seconds: int) -> IncomingEvent:
    return IncomingEvent(
        provider_event_id=f"race-{uuid.uuid4().hex}",
        type=IngestEventType.OBSERVED,
        observed_at=TEST_START + timedelta(seconds=seconds),
        association_ref=enrolled.ref,
        camera_id=enrolled.upper_camera,
        match="CONFIRMED",
        confidence=0.9,
    )


def _alerts(maker: sessionmaker[Session], visit_id: uuid.UUID) -> list[TrackingAlert]:
    with maker() as db:
        return list(db.scalars(select(TrackingAlert).where(TrackingAlert.visit_id == visit_id)))


@pytest.fixture
def pause_after_opening(monkeypatch: pytest.MonkeyPatch) -> dict[str, threading.Event]:
    """Pauses the thread named "batch" once it has opened an alert (holding the company row, its
    association and the new alert), until `release` is set."""
    signals = {"opened": threading.Event(), "release": threading.Event()}
    original = TrackingAlerts._open

    def paused(self: TrackingAlerts, *args: Any, **kwargs: Any) -> None:
        original(self, *args, **kwargs)
        if threading.current_thread().name == "batch":
            signals["opened"].set()
            signals["release"].wait(WAIT)

    monkeypatch.setattr(TrackingAlerts, "_open", paused)
    return signals


def test_two_batches_for_one_visit_never_make_two_active_alerts(
    committed_session_factory: sessionmaker[Session],
    committed_settings,
    committed_engine: Engine,
    hasher,
    pause_after_opening: dict[str, threading.Event],
) -> None:
    provider = RecordingProvider()
    enrolled = _enrolled(committed_session_factory, committed_settings, hasher, provider)
    visit_id, _ground = _allowed_on_the_ground_floor(committed_session_factory, enrolled)
    threads = _Threads()
    second_pid: list[int] = []

    def ingest(name: str, seconds: int) -> Any:
        def work() -> list:
            if name == "second":
                pause_after_opening["opened"].wait(WAIT)
            with committed_session_factory() as db:
                if name == "second":
                    second_pid.append(_backend_pid(db))
                return TrackingIngestion(db, provider).ingest(
                    enrolled.company_id,
                    [_sighting(enrolled, seconds)],
                    key_id=enrolled.key_id,
                    context=SYSTEM_CONTEXT,
                )

        return work

    threads.start("batch", ingest("batch", 1))
    threads.start("second", ingest("second", 2))
    try:
        assert _waits_for_a_lock(committed_engine, second_pid), "the second batch should wait for the first"
    finally:
        pause_after_opening["release"].set()
        threads.join()
    assert threads.errors == {}
    for name in ("batch", "second"):
        assert [outcome.result for outcome in threads.results[name]] == [IngestResult.ACCEPTED]
    [alert] = _alerts(committed_session_factory, visit_id)
    assert (alert.status, alert.observations) == ("OPEN", 2)
    assert alert.last_seen_at == TEST_START + timedelta(seconds=2)


@pytest.mark.parametrize("change", ["check-out", "areas change"])
def test_a_batch_opening_an_alert_and_a_visit_change_do_not_deadlock(
    committed_session_factory: sessionmaker[Session],
    committed_settings,
    committed_engine: Engine,
    hasher,
    pause_after_opening: dict[str, threading.Event],
    change: str,
) -> None:
    """The check-out and the change of the visit's areas lock the company row, the visit, the association,
    then the alert; the batch the company row, the association, then the alert, and never the visit. So
    the change waits for the batch, and then resolves the alert it opened."""
    provider = RecordingProvider()
    enrolled = _enrolled(committed_session_factory, committed_settings, hasher, provider)
    visit_id, ground_id = _allowed_on_the_ground_floor(committed_session_factory, enrolled)
    env = service_environment(committed_settings)
    env = type(env)(
        **{**{field: getattr(env, field) for field in env.__dataclass_fields__}, "tracking": provider}
    )
    threads = _Threads()
    change_pid: list[int] = []

    def ingest() -> list:
        with committed_session_factory() as db:
            return TrackingIngestion(db, provider).ingest(
                enrolled.company_id, [_sighting(enrolled, 1)], key_id=enrolled.key_id, context=SYSTEM_CONTEXT
            )

    def visit_change() -> object:
        pause_after_opening["opened"].wait(WAIT)
        with committed_session_factory() as db:
            change_pid.append(_backend_pid(db))
            reception_id = db.execute(
                text("SELECT id FROM users WHERE company_id = :company AND 'RECEPTIONIST' = ANY(roles)"),
                {"company": enrolled.company_id},
            ).scalar_one()
            reception = db.get(User, reception_id)
            assert reception is not None
            auth = live_auth(db, reception)
            if change == "check-out":
                request = TypeAdapter(CheckOutRequest).validate_python({"method": "MANUAL"})
                return AttendanceService(db, env).check_out(auth, visit_id, request, SYSTEM_CONTEXT)
            upper_id = db.execute(
                text("SELECT id FROM floors WHERE company_id = :company AND level = 3"),
                {"company": enrolled.company_id},
            ).scalar_one()
            body = VisitAccessAreasInput(floor_ids=[ground_id, upper_id], zone_ids=[])
            return VisitsService(db, env).set_access_areas(auth, visit_id, body, SYSTEM_CONTEXT)

    threads.start("batch", ingest)
    threads.start("change", visit_change)
    try:
        waited = _waits_for_a_lock(committed_engine, change_pid)
        assert waited, f"the change should wait for the batch ({threads.errors!r})"
    finally:
        pause_after_opening["release"].set()
        threads.join()
    assert threads.errors == {}
    [alert] = _alerts(committed_session_factory, visit_id)
    expected = "CHECKED_OUT" if change == "check-out" else "AREAS_CHANGED"
    assert (alert.status, alert.resolution) == ("RESOLVED", expected)


def test_a_check_out_holding_the_visit_and_a_batch_that_e_mails_do_not_deadlock(
    committed_session_factory: sessionmaker[Session],
    committed_settings,
    committed_engine: Engine,
    hasher,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The other order (found in review): the check-out holds the visit `FOR UPDATE` before it asks for the
    association. Had the batch taken the association first, opened an alert and written its e-mail row
    (whose foreign key takes the visit `FOR KEY SHARE`), each would wait for the other. The batch takes its
    visits first, so it waits for the check-out at the visit, and then finds the association ended."""
    provider = RecordingProvider()
    enrolled = _enrolled(committed_session_factory, committed_settings, hasher, provider)
    visit_id, _ground = _allowed_on_the_ground_floor(committed_session_factory, enrolled)
    env = service_environment(committed_settings)
    env = type(env)(
        **{**{field: getattr(env, field) for field in env.__dataclass_fields__}, "tracking": provider}
    )
    holding, release = threading.Event(), threading.Event()
    original = TrackingLifecycle.end_for_check_out

    def paused(self: TrackingLifecycle, *args: Any, **kwargs: Any) -> None:
        if threading.current_thread().name == "check-out":
            holding.set()
            release.wait(WAIT)
        original(self, *args, **kwargs)

    monkeypatch.setattr(TrackingLifecycle, "end_for_check_out", paused)
    threads = _Threads()
    batch_pid: list[int] = []

    def check_out() -> object:
        with committed_session_factory() as db:
            reception_id = db.execute(
                text("SELECT id FROM users WHERE company_id = :company AND 'RECEPTIONIST' = ANY(roles)"),
                {"company": enrolled.company_id},
            ).scalar_one()
            reception = db.get(User, reception_id)
            assert reception is not None
            request = TypeAdapter(CheckOutRequest).validate_python({"method": "MANUAL"})
            return AttendanceService(db, env).check_out(
                live_auth(db, reception), visit_id, request, SYSTEM_CONTEXT
            )

    def ingest() -> list:
        holding.wait(WAIT)
        with committed_session_factory() as db:
            batch_pid.append(_backend_pid(db))
            mailer = AlertMailer(env.email_service(db), env.email_quota())
            return TrackingIngestion(db, provider, mailer=mailer).ingest(
                enrolled.company_id, [_sighting(enrolled, 1)], key_id=enrolled.key_id, context=SYSTEM_CONTEXT
            )

    threads.start("check-out", check_out)
    threads.start("batch", ingest)
    try:
        assert _waits_for_a_lock(committed_engine, batch_pid), "the batch should wait for the check-out"
    finally:
        release.set()
        threads.join()
    assert threads.errors == {}
    [outcome] = threads.results["batch"]
    assert (outcome.result, outcome.reason) == (IngestResult.REJECTED, RejectReason.ASSOCIATION_ENDED)
    assert _alerts(committed_session_factory, visit_id) == []
