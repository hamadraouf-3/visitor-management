"""Reception changes race on two real connections (contract §3.2-4, §6, §11): the visit's row lock
serialises check-in, check-out and cancellation, and `uq_visits_visitor_inside` keeps a visitor inside on
one visit at a time. The loser of each race gets the §8.2 code for the state the winner left.

The lock-order claims of B57-11 beyond the visit row: a bulk stale check-out re-checks each visit it
waited for (PostgreSQL re-evaluates the condition on the row it locks), so a visit checked out meanwhile
drops out instead of reaching `visits_terminal_immutable`; and a host's deactivation (D-18) and a check-in
are serialised by the company row, so whichever waits sees the other's result."""

import threading
import time
import uuid
from collections.abc import Callable, Iterator
from datetime import timedelta

import pytest
from pydantic import TypeAdapter
from sqlalchemy import func, select, text
from sqlalchemy.orm import Session, sessionmaker

from app.core.errors import (
    AppError,
    HostInactive,
    InvalidStateTransition,
    VisitAlreadyCheckedIn,
    VisitCancelled,
    VisitNotCheckedIn,
    VisitorAlreadyInside,
)
from app.core.request_context import SYSTEM_CONTEXT
from app.core.time import FakeClock
from app.models import AuditLog, Company, EmailMessage, Role, User, Visit, VisitorPass
from app.schemas.reception import StaleCheckOutRequest, StaleCheckOutResult
from app.schemas.users import UserUpdate
from app.schemas.visits import CheckInRequest, CheckOutRequest, VisitCancel, VisitCreate, WalkInCreate
from app.security.sessions import AuthContext
from app.services.attendance import AttendanceService
from app.services.environment import ServiceEnvironment
from app.services.no_shows import mark_no_shows_committed
from app.services.users import UserUpdateResult
from app.services.visits import VisitsService
from tests.conftest import TEST_START
from tests.support import live_auth, service_environment, unique, users_service

pytestmark = pytest.mark.committed

START = TEST_START + timedelta(hours=1)  # inside the window from the start of the test clock

type Change = Callable[[Session, ServiceEnvironment], object]
type Hold = Callable[[Session], object]  # takes the locks a transaction holds before its change


def _manual_check_in() -> CheckInRequest:
    return TypeAdapter(CheckInRequest).validate_python({"method": "MANUAL"})


def _manual_check_out() -> CheckOutRequest:
    return TypeAdapter(CheckOutRequest).validate_python({"method": "MANUAL"})


def _override_check_in() -> CheckInRequest:
    return TypeAdapter(CheckInRequest).validate_python({"method": "OVERRIDE", "reason": "Late arrival"})


def _auth(db: Session, user_id: uuid.UUID) -> AuthContext:
    user = db.get(User, user_id)
    assert user is not None
    return live_auth(db, user)


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


def _create_visit(db: Session, env: ServiceEnvironment, host_id: uuid.UUID, name: str) -> Visit:
    created = VisitsService(db, env).create_visit(
        _auth(db, host_id),
        VisitCreate.model_validate(
            {
                "visitor": {"full_name": name, "email": f"{unique('visitor')}@example.com"},
                "host_id": str(host_id),
                "purpose": "Race",
                "scheduled_start": START.isoformat(),
                "scheduled_end": (START + timedelta(hours=1)).isoformat(),
                "send_invitation": False,
            }
        ),
        SYSTEM_CONTEXT,
    )
    visit = db.get(Visit, created.payload.visit.id)
    assert visit is not None
    return visit


@pytest.fixture
def scenario(committed_session_factory: sessionmaker[Session], committed_settings, hasher) -> Iterator[dict]:
    """A company with a host, a receptionist and an administrator, and one SCHEDULED visit inside its
    window, committed."""
    env = service_environment(committed_settings)
    with committed_session_factory() as db:
        company = Company(name="Reception Race Co", slug=unique("reception-race"), timezone="Asia/Amman")
        db.add(company)
        db.flush()
        host = _user(db, company, Role.EMPLOYEE, hasher)
        receptionist = _user(db, company, Role.RECEPTIONIST, hasher)
        admin = _user(db, company, Role.SYSTEM_ADMIN, hasher)
        db.commit()
        visit = _create_visit(db, env, host.id, "Race Visitor")
        yield {
            "env": env,
            "settings": committed_settings,
            "hasher": hasher,
            "company_id": company.id,
            "host_id": host.id,
            "receptionist_id": receptionist.id,
            "admin_id": admin.id,
            "visit_id": visit.id,
            "visitor_id": visit.visitor_id,
        }


def _check_in(scenario: dict) -> Change:
    def change(db: Session, env: ServiceEnvironment) -> object:
        auth = _auth(db, scenario["receptionist_id"])
        return AttendanceService(db, env).check_in(
            auth, scenario["visit_id"], _manual_check_in(), SYSTEM_CONTEXT
        )

    return change


def _check_out(scenario: dict) -> Change:
    def change(db: Session, env: ServiceEnvironment) -> object:
        auth = _auth(db, scenario["receptionist_id"])
        return AttendanceService(db, env).check_out(
            auth, scenario["visit_id"], _manual_check_out(), SYSTEM_CONTEXT
        )

    return change


def _cancel(scenario: dict) -> Change:
    def change(db: Session, env: ServiceEnvironment) -> object:
        auth = _auth(db, scenario["host_id"])
        return VisitsService(db, env).cancel_visit(
            auth, scenario["visit_id"], VisitCancel(notify_visitor=False), SYSTEM_CONTEXT
        )

    return change


def _stale_check_out(scenario: dict) -> Change:
    def change(db: Session, env: ServiceEnvironment) -> object:
        auth = _auth(db, scenario["receptionist_id"])
        request = StaleCheckOutRequest(reason="Left without checking out")
        return AttendanceService(db, env).check_out_stale(auth, request, SYSTEM_CONTEXT)

    return change


def _override(scenario: dict) -> Change:
    def change(db: Session, env: ServiceEnvironment) -> object:
        auth = _auth(db, scenario["receptionist_id"])
        return AttendanceService(db, env).check_in(
            auth, scenario["visit_id"], _override_check_in(), SYSTEM_CONTEXT
        )

    return change


def _deactivate_host(scenario: dict) -> Change:
    """The administrator deactivates the host (D-18: the host's SCHEDULED visits are cancelled)."""

    def change(db: Session, env: ServiceEnvironment) -> object:
        auth = _auth(db, scenario["admin_id"])
        service = users_service(db, scenario["hasher"], scenario["settings"])
        return service.update_user(
            auth, scenario["host_id"], UserUpdate.model_validate({"is_active": False}), SYSTEM_CONTEXT
        )

    return change


def _walk_in(scenario: dict) -> Change:
    def change(db: Session, env: ServiceEnvironment) -> object:
        auth = _auth(db, scenario["receptionist_id"])
        data = WalkInCreate.model_validate(
            {
                "visitor_id": str(scenario["visitor_id"]),
                "host_id": str(scenario["host_id"]),
                "purpose": "Came back",
                "expected_end": (START + timedelta(hours=2)).isoformat(),
                "reason": "NO_INVITATION",
            }
        )
        return AttendanceService(db, env).register_walk_in(auth, data, SYSTEM_CONTEXT)

    return change


def _wait_until_waiting(maker: sessionmaker[Session], pids: list[int], timeout: float = 10.0) -> None:
    """Until every backend in `pids` waits for a lock (a row lock, or another transaction's index entry)."""
    deadline = time.monotonic() + timeout
    with maker() as observer:
        while time.monotonic() < deadline:
            waiting = observer.execute(
                text(
                    "SELECT count(*) FROM pg_stat_activity"
                    " WHERE pid = ANY(:pids) AND wait_event_type = 'Lock'"
                ),
                {"pids": pids},
            ).scalar_one()
            observer.rollback()
            if waiting == len(pids):
                return
            time.sleep(0.02)
    raise AssertionError("the transactions never waited for each other")


def _run(
    maker: sessionmaker[Session],
    env: ServiceEnvironment,
    change: Change,
    outcome: dict,
    key: str,
    ready: list,
) -> None:
    db = maker()
    try:
        db.execute(text("SET lock_timeout = '10s'"))
        ready.append(db.execute(text("SELECT pg_backend_pid()")).scalar_one())
        outcome[key] = change(db, env)
    except AppError as exc:
        db.rollback()
        outcome[key] = exc
    except Exception as exc:  # surfaced by the assertions
        outcome[key] = repr(exc)
    finally:
        db.close()


def _hold_visit(scenario: dict) -> Hold:
    return lambda db: db.execute(select(Visit).where(Visit.id == scenario["visit_id"]).with_for_update())


def _hold_company(scenario: dict, *, key_share: bool) -> Hold:
    """The company row as the first lock of a check-in (`FOR KEY SHARE`) or of a user change that affects
    roles or activity (`FOR UPDATE`, `repositories.locking`)."""

    def hold(db: Session) -> object:
        statement = select(Company).where(Company.id == scenario["company_id"])
        return db.execute(statement.with_for_update(read=key_share, key_share=key_share))

    return hold


def _race(
    maker: sessionmaker[Session],
    scenario: dict,
    first: Change,
    second: Change,
    *,
    hold: Hold | None = None,
) -> tuple[object, object]:
    """Transaction 1 holds a lock its change takes (by default the visit's row lock); transaction 2's change
    starts and must wait for it; then transaction 1 makes its change and commits. Returns both outcomes (a
    result or the AppError). The held lock must be one transaction 1's change takes first or in the lock
    order (`repositories.locking`), or the two would deadlock."""
    holder = maker()
    outcome: dict[str, object] = {}
    pids: list[int] = []
    try:
        (hold or _hold_visit(scenario))(holder)
        worker = threading.Thread(target=_run, args=(maker, scenario["env"], second, outcome, "second", pids))
        worker.start()
        while not pids:
            time.sleep(0.01)
        _wait_until_waiting(maker, pids)
        try:
            outcome["first"] = first(holder, scenario["env"])
        except AppError as exc:
            holder.rollback()
            outcome["first"] = exc
        worker.join(timeout=15)
        assert not worker.is_alive()
    finally:
        holder.close()
    return outcome["first"], outcome["second"]


def _simultaneous(maker: sessionmaker[Session], scenario: dict, *changes: Change) -> list[object]:
    """Start every change while another transaction holds the company row `FOR UPDATE` (the first lock
    every visit change takes), so all of them wait at the same point; then release them at once."""
    blocker = maker()
    outcome: dict[str, object] = {}
    pids: list[int] = []
    blocker.execute(select(Company).where(Company.id == scenario["company_id"]).with_for_update())
    workers = [
        threading.Thread(target=_run, args=(maker, scenario["env"], change, outcome, str(index), pids))
        for index, change in enumerate(changes)
    ]
    try:
        for worker in workers:
            worker.start()
        while len(pids) < len(changes):
            time.sleep(0.01)
        _wait_until_waiting(maker, pids)
        blocker.commit()
        for worker in workers:
            worker.join(timeout=15)
            assert not worker.is_alive()
    finally:
        blocker.close()
    return [outcome[str(index)] for index in range(len(changes))]


def _visit(maker: sessionmaker[Session], visit_id: uuid.UUID) -> Visit:
    with maker() as db:
        visit = db.get(Visit, visit_id)
        assert visit is not None
        return visit


def _count(maker: sessionmaker[Session], statement) -> int:
    with maker() as db:
        return int(db.scalar(statement) or 0)


def test_double_check_in_one_wins(committed_session_factory, scenario) -> None:
    first, second = _race(committed_session_factory, scenario, _check_in(scenario), _check_in(scenario))
    assert not isinstance(first, AppError), first
    assert isinstance(second, VisitAlreadyCheckedIn), second
    assert second.details["visit"]["status"] == "CHECKED_IN"
    visit = _visit(committed_session_factory, scenario["visit_id"])
    assert visit.status == "CHECKED_IN"
    checked_in = (
        select(func.count())
        .select_from(AuditLog)
        .where(AuditLog.action == "VISIT_CHECKED_IN", AuditLog.entity_id == scenario["visit_id"])
    )
    assert _count(committed_session_factory, checked_in) == 1
    arrivals = (
        select(func.count())
        .select_from(EmailMessage)
        .where(EmailMessage.kind == "HOST_ARRIVAL", EmailMessage.visit_id == scenario["visit_id"])
    )
    assert _count(committed_session_factory, arrivals) == 1  # the host is told once


def test_check_in_waiting_for_a_cancellation_is_refused(committed_session_factory, scenario) -> None:
    first, second = _race(committed_session_factory, scenario, _cancel(scenario), _check_in(scenario))
    assert not isinstance(first, AppError), first
    assert isinstance(second, VisitCancelled), second
    assert _visit(committed_session_factory, scenario["visit_id"]).status == "CANCELLED"


def test_cancellation_waiting_for_a_check_in_is_refused(committed_session_factory, scenario) -> None:
    first, second = _race(committed_session_factory, scenario, _check_in(scenario), _cancel(scenario))
    assert not isinstance(first, AppError), first
    assert isinstance(second, InvalidStateTransition), second
    visit = _visit(committed_session_factory, scenario["visit_id"])
    assert visit.status == "CHECKED_IN" and visit.cancelled_at is None


def test_double_check_out_one_wins(committed_session_factory, scenario) -> None:
    with committed_session_factory() as db:
        _check_in(scenario)(db, scenario["env"])
    first, second = _race(committed_session_factory, scenario, _check_out(scenario), _check_out(scenario))
    assert not isinstance(first, AppError), first
    assert isinstance(second, VisitNotCheckedIn), second
    visit = _visit(committed_session_factory, scenario["visit_id"])
    assert visit.status == "CHECKED_OUT"
    checked_out = (
        select(func.count())
        .select_from(AuditLog)
        .where(AuditLog.action == "VISIT_CHECKED_OUT", AuditLog.entity_id == scenario["visit_id"])
    )
    assert _count(committed_session_factory, checked_out) == 1
    active = (
        select(func.count())
        .select_from(VisitorPass)
        .where(VisitorPass.visit_id == scenario["visit_id"], VisitorPass.revoked_at.is_(None))
    )
    assert _count(committed_session_factory, active) == 0


def test_a_walk_in_and_a_check_in_of_the_same_visitor_one_wins(committed_session_factory, scenario) -> None:
    """Both write the visitor's `uq_visits_visitor_inside` entry; the second waits for the first's commit
    and is refused, whichever order the database lets them in."""
    outcomes = _simultaneous(committed_session_factory, scenario, _walk_in(scenario), _check_in(scenario))
    refused = [outcome for outcome in outcomes if isinstance(outcome, AppError)]
    assert len(refused) == 1 and isinstance(refused[0], VisitorAlreadyInside), outcomes
    assert [outcome for outcome in outcomes if not isinstance(outcome, AppError | str)], outcomes
    inside = (
        select(func.count())
        .select_from(Visit)
        .where(Visit.visitor_id == scenario["visitor_id"], Visit.status == "CHECKED_IN")
    )
    assert _count(committed_session_factory, inside) == 1


def test_a_walk_in_waiting_for_an_uncommitted_check_in_is_refused(
    committed_session_factory, scenario
) -> None:
    """Another transaction has written the visitor's check-in (and its index entry) but not committed when
    the walk-in arrives: the walk-in waits for it and is then refused."""
    holder = committed_session_factory()
    outcome: dict[str, object] = {}
    pids: list[int] = []
    try:
        visit = holder.execute(
            select(Visit).where(Visit.id == scenario["visit_id"]).with_for_update()
        ).scalar_one()
        visit.status = "CHECKED_IN"
        visit.check_in_at = START
        visit.checked_in_by_id = scenario["receptionist_id"]
        visit.check_in_method = "MANUAL"
        holder.flush()
        worker = threading.Thread(
            target=_run,
            args=(committed_session_factory, scenario["env"], _walk_in(scenario), outcome, "walk_in", pids),
        )
        worker.start()
        while not pids:
            time.sleep(0.01)
        _wait_until_waiting(committed_session_factory, pids)
        holder.commit()
        worker.join(timeout=15)
        assert not worker.is_alive()
    finally:
        holder.close()
    assert isinstance(outcome["walk_in"], VisitorAlreadyInside), outcome
    walk_ins = (
        select(func.count())
        .select_from(Visit)
        .where(Visit.visitor_id == scenario["visitor_id"], Visit.is_walk_in.is_(True))
    )
    assert _count(committed_session_factory, walk_ins) == 0


# ---- bulk stale check-out (B57-11, B57-71) --------------------------------------------------------


@pytest.fixture
def stale(committed_session_factory: sessionmaker[Session], scenario: dict, clock: FakeClock) -> list:
    """The scenario's visit and a second visit, both checked in on 5 October and overdue the next morning:
    the bulk action's set. Returns their IDs in id order (the bulk action's lock order)."""
    env = scenario["env"]
    with committed_session_factory() as db:
        other = _create_visit(db, env, scenario["host_id"], "Second Race Visitor")
        for visit_id in (scenario["visit_id"], other.id):
            AttendanceService(db, env).check_in(
                _auth(db, scenario["receptionist_id"]), visit_id, _manual_check_in(), SYSTEM_CONTEXT
            )
    clock.advance(days=1)  # 09:00 on 6 October in Amman: checked in yesterday, scheduled end passed
    return sorted([scenario["visit_id"], other.id])


def _hold_stale(visit_ids: list) -> Hold:
    """The stale visits locked in id order, as the bulk action locks them."""
    statement = select(Visit).where(Visit.id.in_(visit_ids)).order_by(Visit.id).with_for_update()
    return lambda db: db.execute(statement).all()


def _check_out_rows(maker: sessionmaker[Session], visit_ids: list) -> dict:
    with maker() as db:
        rows = db.scalars(
            select(AuditLog).where(AuditLog.action == "VISIT_CHECKED_OUT", AuditLog.entity_id.in_(visit_ids))
        ).all()
        return {
            visit_id: [row.meta["method"] for row in rows if row.entity_id == visit_id]
            for visit_id in visit_ids
        }


def _stale_counts(maker: sessionmaker[Session], scenario: dict) -> list[int]:
    with maker() as db:
        rows = db.scalars(
            select(AuditLog)
            .where(
                AuditLog.action == "STALE_VISITS_CHECKED_OUT", AuditLog.company_id == scenario["company_id"]
            )
            .order_by(AuditLog.seq)
        ).all()
        return [row.meta["count"] for row in rows]


def test_a_stale_check_out_waiting_for_a_check_out_leaves_that_visit_out(
    committed_session_factory, scenario, stale
) -> None:
    """The bulk action waits for the visit a MANUAL check-out holds; once that commits, the visit no longer
    matches and is skipped (no second check-out, no `visits_terminal_immutable` error), and the count
    names only the visit the bulk action checked out."""
    first, second = _race(
        committed_session_factory, scenario, _check_out(scenario), _stale_check_out(scenario)
    )
    assert not isinstance(first, AppError | str), first
    assert second == StaleCheckOutResult(checked_out=1), second
    other = next(visit_id for visit_id in stale if visit_id != scenario["visit_id"])
    assert _check_out_rows(committed_session_factory, stale) == {
        scenario["visit_id"]: ["MANUAL"],
        other: ["BULK"],
    }
    assert _stale_counts(committed_session_factory, scenario) == [1]
    raced = _visit(committed_session_factory, scenario["visit_id"])
    assert (raced.status, raced.check_out_method, raced.check_out_note) == ("CHECKED_OUT", "MANUAL", None)


def test_a_check_out_waiting_for_a_stale_check_out_is_refused(
    committed_session_factory, scenario, stale
) -> None:
    first, second = _race(
        committed_session_factory, scenario, _stale_check_out(scenario), _check_out(scenario)
    )
    assert first == StaleCheckOutResult(checked_out=2), first
    assert isinstance(second, VisitNotCheckedIn), second
    assert second.details["visit"]["check_out_method"] == "BULK"
    assert _check_out_rows(committed_session_factory, stale) == {visit_id: ["BULK"] for visit_id in stale}
    assert _stale_counts(committed_session_factory, scenario) == [2]


def test_two_stale_check_outs_check_each_visit_out_once(committed_session_factory, scenario, stale) -> None:
    """A second bulk run (another desk, a double submit) waits for the first one's visits, then finds
    nothing left: it checks out none and records a count of 0."""
    first, second = _race(
        committed_session_factory,
        scenario,
        _stale_check_out(scenario),
        _stale_check_out(scenario),
        hold=_hold_stale(stale),
    )
    assert first == StaleCheckOutResult(checked_out=2), first
    assert second == StaleCheckOutResult(checked_out=0), second
    assert _check_out_rows(committed_session_factory, stale) == {visit_id: ["BULK"] for visit_id in stale}
    assert _stale_counts(committed_session_factory, scenario) == [2, 0]


# ---- a check-in and the host's deactivation (D-18) -----------------------------------------------


def _host_active(maker: sessionmaker[Session], scenario: dict) -> bool:
    with maker() as db:
        host = db.get(User, scenario["host_id"])
        assert host is not None
        return host.is_active


def test_a_check_in_waiting_for_the_hosts_deactivation_is_refused(
    committed_session_factory, scenario
) -> None:
    """The deactivation holds the company row (`FOR UPDATE`) and cancels the host's SCHEDULED visit; the
    check-in waiting for it then finds the visit cancelled: VISIT_CANCELLED, and the host is not told."""
    first, second = _race(
        committed_session_factory,
        scenario,
        _deactivate_host(scenario),
        _check_in(scenario),
        hold=_hold_company(scenario, key_share=False),
    )
    assert isinstance(first, UserUpdateResult) and first.cancelled_visits == 1, first
    assert isinstance(second, VisitCancelled), second
    assert second.details["check_in_options"] == []
    visit = _visit(committed_session_factory, scenario["visit_id"])
    assert (visit.status, visit.check_in_at) == ("CANCELLED", None)
    checked_in = (
        select(func.count())
        .select_from(AuditLog)
        .where(AuditLog.action == "VISIT_CHECKED_IN", AuditLog.entity_id == scenario["visit_id"])
    )
    assert _count(committed_session_factory, checked_in) == 0
    arrivals = (
        select(func.count()).select_from(EmailMessage).where(EmailMessage.visit_id == scenario["visit_id"])
    )
    assert _count(committed_session_factory, arrivals) == 0


def test_a_deactivation_waiting_for_a_check_in_leaves_the_visit_inside(
    committed_session_factory, scenario
) -> None:
    """The check-in holds the company row (`FOR KEY SHARE`), so the deactivation waits for it; it then finds
    no SCHEDULED visit to cancel, and the visitor stays inside (on the evacuation list)."""
    first, second = _race(
        committed_session_factory,
        scenario,
        _check_in(scenario),
        _deactivate_host(scenario),
        hold=_hold_company(scenario, key_share=True),
    )
    assert not isinstance(first, AppError | str), first
    assert isinstance(second, UserUpdateResult) and second.cancelled_visits is None, second
    assert not _host_active(committed_session_factory, scenario)
    visit = _visit(committed_session_factory, scenario["visit_id"])
    assert (visit.status, visit.cancelled_at) == ("CHECKED_IN", None)


def test_an_override_waiting_for_the_hosts_deactivation_is_refused(
    committed_session_factory, scenario, clock: FakeClock
) -> None:
    """D-18 leaves a NO_SHOW visit alone, so here the host's row decides (B57-63): an OVERRIDE that waited
    for the deactivation answers HOST_INACTIVE instead of checking the visitor in for an inactive host."""
    clock.advance(hours=4)  # 13:00 in Amman: the window ended, still the visit's day
    with committed_session_factory() as db:
        assert mark_no_shows_committed(db, scenario["company_id"], now=clock.now()) == [scenario["visit_id"]]
    first, second = _race(
        committed_session_factory,
        scenario,
        _deactivate_host(scenario),
        _override(scenario),
        hold=_hold_company(scenario, key_share=False),
    )
    assert isinstance(first, UserUpdateResult) and first.cancelled_visits is None, first
    assert isinstance(second, HostInactive), second
    assert second.details["check_in_options"] == []
    visit = _visit(committed_session_factory, scenario["visit_id"])
    assert (visit.status, visit.check_in_at) == ("NO_SHOW", None)
