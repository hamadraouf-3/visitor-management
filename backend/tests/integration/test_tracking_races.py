"""The Visitor Journey's ingestion races on real connections (Phase 15, after the independent review): a
batch takes the company row first like every other writer (B15-29), so it never deadlocks with switching
tracking off or revoking its key; a key revoked while a batch waits for the company row is seen by the
batch (SEC-07); and a concurrent redelivery of the same ENROLLED event is a duplicate, not a refusal
(B15-33)."""

import threading
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import timedelta
from typing import Any

import pytest
from pydantic import TypeAdapter
from sqlalchemy import Engine, select, text
from sqlalchemy.orm import Session, sessionmaker

from app.core.errors import NotAuthenticated
from app.core.request_context import SYSTEM_CONTEXT
from app.models import Company, Role, TrackingKey, User
from app.repositories.tracking import JourneyEventRepository
from app.schemas.journeys import TrackingEnrollRequest
from app.schemas.tracking import TrackingSettingsUpdate
from app.schemas.visits import CheckInRequest, VisitCreate
from app.services.attendance import AttendanceService
from app.services.journeys import JourneyService
from app.services.tracking_ingestion import TrackingIngestion
from app.services.tracking_provider import IncomingEvent, TrackingProvider
from app.services.tracking_rules import IngestEventType, IngestResult
from app.services.tracking_settings import TrackingSettingsService
from app.services.visits import VisitsService
from tests.conftest import TEST_START
from tests.support import live_auth, service_environment, unique
from tests.tracking_support import (
    RecordingProvider,
    SilentProvider,
    registry,
    tracking_key,
    tracking_settings,
)

pytestmark = pytest.mark.committed

START = TEST_START + timedelta(hours=1)
WAIT = 15  # seconds; a deadlock or a lost wake-up fails the test instead of hanging it


@dataclass(frozen=True)
class Enrolled:
    company_id: uuid.UUID
    admin_id: uuid.UUID
    key_id: uuid.UUID
    ref: str
    status: str
    reception_camera: str
    upper_camera: str


def _user(db: Session, company: Company, role: Role, hasher) -> User:
    user = User(
        company_id=company.id,
        full_name=f"Race {role.value.title()}",
        email=f"{unique(role.value.lower())}@example.com",
        password_hash=hasher.hash("Committed-Password-1"),
        roles=[role.value],
    )
    db.add(user)
    return user


def _enrolled(maker: sessionmaker[Session], settings, hasher, provider: TrackingProvider) -> Enrolled:
    """A company with tracking on and a key, and one checked-in visit enrolled with `provider`; committed."""
    env = service_environment(settings)
    with maker() as db:
        company = Company(name="Race Co", slug=unique("race"), timezone="Asia/Amman")
        db.add(company)
        db.flush()
        host = _user(db, company, Role.EMPLOYEE, hasher)
        reception = _user(db, company, Role.RECEPTIONIST, hasher)
        admin = _user(db, company, Role.SYSTEM_ADMIN, hasher)
        db.commit()
        created = VisitsService(db, env).create_visit(
            live_auth(db, host),
            VisitCreate.model_validate(
                {
                    "visitor": {"full_name": "Race Visitor", "email": f"{unique('v')}@example.com"},
                    "host_id": str(host.id),
                    "purpose": "Race",
                    "scheduled_start": START.isoformat(),
                    "scheduled_end": (START + timedelta(hours=1)).isoformat(),
                    "send_invitation": False,
                }
            ),
            SYSTEM_CONTEXT,
        )
        visit_id = created.payload.visit.id
        AttendanceService(db, env).check_in(
            live_auth(db, reception),
            visit_id,
            TypeAdapter(CheckInRequest).validate_python({"method": "MANUAL"}),
            SYSTEM_CONTEXT,
        )
        places = registry(db, company)
        tracking_settings(db, company)
        tracking_key(db, company, admin)
        key_id = db.scalars(select(TrackingKey.id).where(TrackingKey.company_id == company.id)).one()
        JourneyService(db, provider).enroll(
            live_auth(db, reception),
            visit_id,
            TrackingEnrollRequest(camera_id=places.reception_camera.id),
            SYSTEM_CONTEXT,
        )
        association = db.execute(
            text("SELECT ref, status FROM tracking_associations WHERE visit_id = :visit"), {"visit": visit_id}
        ).one()
        return Enrolled(
            company_id=company.id,
            admin_id=admin.id,
            key_id=key_id,
            ref=association.ref,
            status=association.status,
            reception_camera=places.reception_camera.provider_camera_id,
            upper_camera=places.upper_camera.provider_camera_id,
        )


def _sighting(enrolled: Enrolled) -> IncomingEvent:
    return IncomingEvent(
        provider_event_id=f"race-{uuid.uuid4().hex}",
        type=IngestEventType.OBSERVED,
        observed_at=TEST_START,
        association_ref=enrolled.ref,
        camera_id=enrolled.upper_camera,
        match="CONFIRMED",
        confidence=0.9,
    )


def _backend_pid(db: Session) -> int:
    return db.execute(text("SELECT pg_backend_pid()")).scalar_one()


def _waits_for_a_lock(engine: Engine, pids: list[int]) -> bool:
    """Whether the backend whose PID lands in `pids` is (soon) waiting for a row lock."""
    deadline = time.monotonic() + WAIT
    while time.monotonic() < deadline:
        if pids:
            with engine.connect() as connection:
                waiting = connection.execute(
                    text("SELECT wait_event_type FROM pg_stat_activity WHERE pid = :pid"), {"pid": pids[0]}
                ).scalar_one_or_none()
            if waiting == "Lock":
                return True
        time.sleep(0.05)
    return False


class _Threads:
    """Runs named callables in threads, keeping their results and exceptions."""

    def __init__(self) -> None:
        self.results: dict[str, Any] = {}
        self.errors: dict[str, BaseException] = {}
        self._threads: list[threading.Thread] = []

    def start(self, name: str, work: Callable[[], Any]) -> None:
        def run() -> None:
            try:
                self.results[name] = work()
            except BaseException as exc:  # reported by the test
                self.errors[name] = exc

        thread = threading.Thread(target=run, name=name)
        self._threads.append(thread)
        thread.start()

    def join(self) -> None:
        for thread in self._threads:
            thread.join(WAIT * 2)
            assert not thread.is_alive(), f"{thread.name} is still running"


@pytest.fixture
def batch_holds_its_association(monkeypatch: pytest.MonkeyPatch) -> dict[str, threading.Event]:
    """Pauses the batch running in thread "batch" as it stores its first event, holding the company row
    (KEY SHARE) and its association (FOR UPDATE), until `release` is set."""
    signals = {"holding": threading.Event(), "release": threading.Event()}
    original = JourneyEventRepository.add

    def add(self: JourneyEventRepository, values: dict[str, Any]) -> bool:
        if threading.current_thread().name == "batch" and not signals["holding"].is_set():
            signals["holding"].set()
            signals["release"].wait(WAIT)
        return original(self, values)

    monkeypatch.setattr(JourneyEventRepository, "add", add)
    return signals


@pytest.mark.parametrize("change", ["switch off", "revoke the key"])
def test_a_batch_and_a_company_wide_change_do_not_deadlock(
    committed_session_factory: sessionmaker[Session],
    committed_settings,
    committed_engine: Engine,
    hasher,
    batch_holds_its_association: dict[str, threading.Event],
    change: str,
) -> None:
    """B15-29: before, the batch locked its key and association first and the company row last (through
    the event's foreign keys), while the change locks the company row FOR UPDATE first and then the
    associations: each waited for the other. Now the change simply waits for the batch."""
    provider = RecordingProvider()
    enrolled = _enrolled(committed_session_factory, committed_settings, hasher, provider)
    assert enrolled.status == "ACTIVE"
    threads = _Threads()
    change_pid: list[int] = []

    def ingest() -> list:
        with committed_session_factory() as db:
            return TrackingIngestion(db, provider).ingest(
                enrolled.company_id, [_sighting(enrolled)], key_id=enrolled.key_id, context=SYSTEM_CONTEXT
            )

    def company_wide_change() -> object:
        batch_holds_its_association["holding"].wait(WAIT)
        with committed_session_factory() as db:
            change_pid.append(_backend_pid(db))
            admin = db.get(User, enrolled.admin_id)
            assert admin is not None
            service = TrackingSettingsService(db, provider)
            if change == "switch off":
                update = TrackingSettingsUpdate.model_validate({"enabled": False})
                return service.update(live_auth(db, admin), update, SYSTEM_CONTEXT)
            return service.revoke_key(live_auth(db, admin), enrolled.key_id, SYSTEM_CONTEXT)

    threads.start("batch", ingest)
    threads.start("change", company_wide_change)
    try:
        assert _waits_for_a_lock(committed_engine, change_pid), "the change should wait for the batch"
    finally:
        batch_holds_its_association["release"].set()
        threads.join()
    assert threads.errors == {}
    [outcome] = threads.results["batch"]
    assert outcome.result is IngestResult.ACCEPTED
    with committed_session_factory() as db:
        status, ended = db.execute(
            text("SELECT status, ended_reason FROM tracking_associations WHERE ref = :ref"),
            {"ref": enrolled.ref},
        ).one()
        revoked = db.execute(
            text("SELECT revoked_at IS NOT NULL FROM tracking_keys WHERE id = :id"), {"id": enrolled.key_id}
        ).scalar_one()
    if change == "switch off":
        assert (status, ended) == ("ENDED", "REVOKED")
    else:
        assert status == "ACTIVE" and revoked is True


def test_a_key_revoked_while_its_batch_waits_for_the_company_row_is_refused(
    committed_session_factory: sessionmaker[Session], committed_settings, committed_engine: Engine, hasher
) -> None:
    """B15-29, SEC-07: the key is checked again once the batch holds the company row, so a revocation that
    committed while the batch waited wins and nothing of the batch is stored."""
    provider = RecordingProvider()
    enrolled = _enrolled(committed_session_factory, committed_settings, hasher, provider)
    threads = _Threads()
    batch_pid: list[int] = []
    event = _sighting(enrolled)

    def ingest() -> list:
        with committed_session_factory() as db:
            batch_pid.append(_backend_pid(db))
            return TrackingIngestion(db, provider).ingest(
                enrolled.company_id, [event], key_id=enrolled.key_id, context=SYSTEM_CONTEXT
            )

    with committed_session_factory() as revoking:
        # What a revocation does first: the company row FOR UPDATE, then the key.
        revoking.execute(
            text("SELECT id FROM companies WHERE id = :id FOR UPDATE"), {"id": enrolled.company_id}
        )
        revoking.execute(
            text("UPDATE tracking_keys SET revoked_at = now() WHERE id = :id"), {"id": enrolled.key_id}
        )
        threads.start("batch", ingest)
        try:
            assert _waits_for_a_lock(committed_engine, batch_pid), "the batch should wait for the company row"
        finally:
            revoking.commit()
            threads.join()
    assert isinstance(threads.errors.get("batch"), NotAuthenticated)
    with committed_session_factory() as db:
        stored = db.execute(
            text("SELECT count(*) FROM visitor_journey_events WHERE provider_event_id = :id"),
            {"id": event.provider_event_id},
        ).scalar_one()
    assert stored == 0


def test_a_concurrent_redelivery_of_the_same_enrolled_event_is_a_duplicate(
    committed_session_factory: sessionmaker[Session],
    committed_settings,
    committed_engine: Engine,
    hasher,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """B15-33: the second delivery waits for the first one's association lock and only then reads which
    events are known, so it answers `duplicate` (not `rejected ALREADY_ENROLLED`), and the provider stops
    retrying it."""
    provider = SilentProvider()
    enrolled = _enrolled(committed_session_factory, committed_settings, hasher, provider)
    assert enrolled.status == "PENDING"
    stored = threading.Event()
    release = threading.Event()
    original = JourneyEventRepository.add

    def add(self: JourneyEventRepository, values: dict[str, Any]) -> bool:
        inserted = original(self, values)
        if threading.current_thread().name == "first":
            stored.set()
            release.wait(WAIT)
        return inserted

    monkeypatch.setattr(JourneyEventRepository, "add", add)
    event = IncomingEvent(
        provider_event_id=f"enrolled-{uuid.uuid4().hex}",
        type=IngestEventType.ENROLLED,
        observed_at=TEST_START,
        association_ref=enrolled.ref,
        camera_id=enrolled.reception_camera,
    )
    threads = _Threads()
    second_pid: list[int] = []

    def deliver(name: str) -> Callable[[], list]:
        def work() -> list:
            if name == "second":
                stored.wait(WAIT)
            with committed_session_factory() as db:
                if name == "second":
                    second_pid.append(_backend_pid(db))
                return TrackingIngestion(db, provider).ingest(
                    enrolled.company_id, [event], key_id=None, context=SYSTEM_CONTEXT
                )

        return work

    threads.start("first", deliver("first"))
    threads.start("second", deliver("second"))
    try:
        assert _waits_for_a_lock(committed_engine, second_pid), "the redelivery should wait for the first"
    finally:
        release.set()
        threads.join()
    assert threads.errors == {}
    assert [(o.result, o.reason) for o in threads.results["first"]] == [(IngestResult.ACCEPTED, None)]
    assert [(o.result, o.reason) for o in threads.results["second"]] == [(IngestResult.DUPLICATE, None)]
