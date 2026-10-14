"""Visit changes race on two real connections (contract §3.2-4, §11): the `SELECT … FOR UPDATE` on the
visit serialises them, and the second change sees the first one's committed result. Creating a visit
locks the rows it depends on, so a concurrent host deactivation (D-18) or visitor address change (D-19)
is seen by it, or sees it."""

import threading
import time
import uuid
from collections.abc import Callable, Iterator
from datetime import timedelta

import pytest
from sqlalchemy import select, text
from sqlalchemy.orm import Session, sessionmaker

from app.core.errors import AppError, ValidationFailed, VisitNotEditable
from app.core.request_context import SYSTEM_CONTEXT
from app.models import (
    Company,
    Department,
    EmailMessage,
    Role,
    User,
    Visit,
    Visitor,
    VisitorPass,
)
from app.schemas.departments import DepartmentUpdate
from app.schemas.users import UserUpdate
from app.schemas.visitors import VisitorUpdate
from app.schemas.visits import VisitCancel, VisitCreate, VisitUpdate
from app.security.sessions import AuthContext
from app.security.tokens import hash_token
from app.services.departments import DEPARTMENT_INACTIVE, DepartmentsService
from app.services.visit_hooks import VisitSnapshots
from app.services.visitors import VisitorsService
from app.services.visits import HOST_NOT_AVAILABLE, VisitsService
from tests.conftest import TEST_START
from tests.support import live_auth, pass_token, service_environment, unique, users_service

pytestmark = pytest.mark.committed

START = TEST_START + timedelta(hours=1)


@pytest.fixture
def scenario(committed_session_factory: sessionmaker[Session], committed_settings, hasher) -> Iterator[dict]:
    """A company, a host and one SCHEDULED visit with an e-mail address, all committed."""
    env = service_environment(committed_settings)
    with committed_session_factory() as db:
        company = Company(name="Race Co", slug=unique("race"), timezone="Asia/Amman")
        db.add(company)
        db.flush()
        host = User(
            company_id=company.id,
            full_name="Race Host",
            email=f"{unique('host')}@example.com",
            password_hash=hasher.hash("Committed-Password-1"),
            roles=[Role.EMPLOYEE.value],
        )
        db.add(host)
        db.commit()
        auth = _auth(db, host.id)
        result = VisitsService(db, env).create_visit(
            auth,
            VisitCreate.model_validate(
                {
                    "visitor": {"full_name": "Race Guest", "email": f"{unique('guest')}@example.com"},
                    "host_id": str(host.id),
                    "purpose": "Race",
                    "scheduled_start": START.isoformat(),
                    "scheduled_end": (START + timedelta(hours=1)).isoformat(),
                    "send_invitation": True,
                }
            ),
            SYSTEM_CONTEXT,
        )
        yield {
            "env": env,
            "company_id": company.id,
            "host_id": host.id,
            "visit_id": result.payload.visit.id,
            "pass_url": result.payload.pass_url,
        }


def _auth(db: Session, user_id: uuid.UUID, role: Role = Role.EMPLOYEE) -> AuthContext:
    user = db.get(User, user_id)
    assert user is not None
    return live_auth(db, user, frozenset({role}))


def _wait_for_lock_wait(maker: sessionmaker[Session], pid: int, timeout: float = 10.0) -> None:
    deadline = time.monotonic() + timeout
    with maker() as observer:
        while time.monotonic() < deadline:
            waiting = observer.execute(
                text("SELECT wait_event_type FROM pg_stat_activity WHERE pid = :pid"), {"pid": pid}
            ).scalar()
            observer.rollback()
            if waiting == "Lock":
                return
            time.sleep(0.02)
    raise AssertionError("the second transaction never waited for the visit lock")


def _race(
    maker: sessionmaker[Session],
    scenario: dict,
    first_change: Callable[[VisitsService, AuthContext], object],
    second_change: Callable[[VisitsService, AuthContext], object],
) -> tuple[object, object]:
    """Transaction 1 locks the visit; transaction 2's change starts and must wait; then transaction 1
    makes its change and commits. Returns both outcomes (a result or the raised AppError)."""
    first, second = maker(), maker()
    outcome: dict[str, object] = {}
    try:
        first_auth, second_auth = _auth(first, scenario["host_id"]), _auth(second, scenario["host_id"])
        second.execute(text("SET lock_timeout = '10s'"))
        second_pid = second.execute(text("SELECT pg_backend_pid()")).scalar_one()
        first.execute(select(Visit).where(Visit.id == scenario["visit_id"]).with_for_update())

        def run_second() -> None:
            try:
                outcome["second"] = second_change(VisitsService(second, scenario["env"]), second_auth)
            except AppError as exc:
                second.rollback()
                outcome["second"] = exc
            except Exception as exc:  # surfaced by the assertions
                outcome["second"] = repr(exc)

        worker = threading.Thread(target=run_second)
        worker.start()
        _wait_for_lock_wait(maker, second_pid)
        outcome["first"] = first_change(VisitsService(first, scenario["env"]), first_auth)
        worker.join(timeout=15)
        assert not worker.is_alive()
    finally:
        first.close()
        second.close()
    return outcome["first"], outcome["second"]


def _passes(maker: sessionmaker[Session], visit_id: uuid.UUID) -> list[VisitorPass]:
    with maker() as db:
        return list(
            db.scalars(
                select(VisitorPass).where(VisitorPass.visit_id == visit_id).order_by(VisitorPass.created_at)
            )
        )


def test_double_resend_rotates_twice_and_keeps_one_active_pass(committed_session_factory, scenario) -> None:
    def resend(service: VisitsService, auth: AuthContext):
        return service.resend_invitation(auth, scenario["visit_id"], SYSTEM_CONTEXT)

    first, second = _race(committed_session_factory, scenario, resend, resend)
    assert not isinstance(first, AppError) and not isinstance(second, AppError), (first, second)
    first_url, second_url = first.payload.pass_url, second.payload.pass_url  # type: ignore[union-attr]
    assert len({scenario["pass_url"], first_url, second_url}) == 3
    passes = _passes(committed_session_factory, scenario["visit_id"])
    assert [p.revoke_reason for p in passes] == ["ROTATED", "ROTATED", None]
    # The waiting transaction rotated last: only its pass works.
    assert passes[-1].token_hash == hash_token(pass_token(second_url))
    assert passes[1].token_hash == hash_token(pass_token(first_url))


def test_cancel_wins_over_a_waiting_reschedule(committed_session_factory, scenario) -> None:
    new_start = START + timedelta(hours=2)

    def cancel(service: VisitsService, auth: AuthContext):
        return service.cancel_visit(
            auth, scenario["visit_id"], VisitCancel(notify_visitor=False), SYSTEM_CONTEXT
        )

    def reschedule(service: VisitsService, auth: AuthContext):
        return service.update_visit(
            auth,
            scenario["visit_id"],
            VisitUpdate(scheduled_start=new_start, scheduled_end=new_start + timedelta(hours=1)),
            SYSTEM_CONTEXT,
        )

    first, second = _race(committed_session_factory, scenario, cancel, reschedule)
    assert not isinstance(first, AppError)
    assert isinstance(second, VisitNotEditable)
    with committed_session_factory() as db:
        visit = db.get(Visit, scenario["visit_id"])
        assert visit is not None and visit.status == "CANCELLED"
        assert visit.scheduled_start == START  # the reschedule never happened


def test_reschedule_then_waiting_cancel(committed_session_factory, scenario) -> None:
    new_start = START + timedelta(hours=2)

    def reschedule(service: VisitsService, auth: AuthContext):
        return service.update_visit(
            auth,
            scenario["visit_id"],
            VisitUpdate(scheduled_start=new_start, scheduled_end=new_start + timedelta(hours=1)),
            SYSTEM_CONTEXT,
        )

    def cancel(service: VisitsService, auth: AuthContext):
        return service.cancel_visit(auth, scenario["visit_id"], VisitCancel(reason="Late"), SYSTEM_CONTEXT)

    first, second = _race(committed_session_factory, scenario, reschedule, cancel)
    assert not isinstance(first, AppError) and not isinstance(second, AppError), (first, second)
    with committed_session_factory() as db:
        visit = db.get(Visit, scenario["visit_id"])
        assert visit is not None and visit.status == "CANCELLED"
        assert visit.scheduled_start == new_start and visit.cancellation_reason == "Late"
    assert [p.revoke_reason for p in _passes(committed_session_factory, scenario["visit_id"])] == [
        "VISIT_CANCELLED"
    ]


# ---- creating a visit while what it depends on changes -----------------------------------------


@pytest.fixture
def people(committed_session_factory: sessionmaker[Session], hasher) -> Iterator[dict]:
    """A company with an administrator, a host and a visitor with an e-mail address, all committed."""
    with committed_session_factory() as db:
        company = Company(name="Create Race Co", slug=unique("create-race"), timezone="Asia/Amman")
        db.add(company)
        db.flush()
        password_hash = hasher.hash("Committed-Password-1")

        def user(role: Role) -> User:
            return User(
                company_id=company.id,
                full_name=unique(role.value.title()),
                email=f"{unique('user')}@example.com",
                password_hash=password_hash,
                roles=[role.value],
            )

        admin, host = user(Role.SYSTEM_ADMIN), user(Role.EMPLOYEE)
        db.add_all([admin, host])
        db.flush()
        visitor = Visitor(
            company_id=company.id,
            full_name="Moving Guest",
            email=f"{unique('old')}@example.com",
            search_text="moving guest",
            name_sort="moving guest",
            created_by_id=host.id,
        )
        db.add(visitor)
        db.commit()
        yield {
            "company_id": company.id,
            "admin_id": admin.id,
            "host_id": host.id,
            "visitor_id": visitor.id,
            "old_email": visitor.email,
        }


def _create_invited_visit(service: VisitsService, auth: AuthContext, host_id, visitor_id):
    return service.create_visit(
        auth,
        VisitCreate.model_validate(
            {
                "visitor_id": str(visitor_id),
                "host_id": str(host_id),
                "purpose": "Race",
                "scheduled_start": START.isoformat(),
                "scheduled_end": (START + timedelta(hours=1)).isoformat(),
                "send_invitation": True,
            }
        ),
        SYSTEM_CONTEXT,
    )


def _while_holding(
    maker: sessionmaker[Session],
    hold: Callable[[Session], object],
    waiting_change: Callable[[Session], object],
    first_change: Callable[[Session], object],
) -> object:
    """Transaction 1 takes the lock its change takes first (`hold`); transaction 2 starts its change and
    must wait; transaction 1 then makes its change and commits. Returns transaction 2's outcome (a
    result, or the raised AppError)."""
    first, second = maker(), maker()
    outcome: dict[str, object] = {}
    try:
        second.execute(text("SET lock_timeout = '10s'"))
        second_pid = second.execute(text("SELECT pg_backend_pid()")).scalar_one()
        hold(first)

        def run_second() -> None:
            try:
                outcome["second"] = waiting_change(second)
            except AppError as exc:
                second.rollback()
                outcome["second"] = exc
            except Exception as exc:  # surfaced by the assertions
                outcome["second"] = repr(exc)

        worker = threading.Thread(target=run_second)
        worker.start()
        _wait_for_lock_wait(maker, second_pid)
        first_change(first)
        worker.join(timeout=15)
        assert not worker.is_alive()
    finally:
        first.close()
        second.close()
    return outcome["second"]


def test_a_visit_created_during_an_email_change_is_invited_at_the_new_address(
    committed_session_factory, committed_settings, people
) -> None:
    """D-19: the change holds the visitor row while it re-invites the visitor's SCHEDULED visits. A visit
    being created meanwhile used to read the old address, wait at its foreign-key check, and commit an
    active pass sent to that address after the change had re-issued everything else."""
    env = service_environment(committed_settings)
    new_email = f"{unique('new')}@example.com"

    created = _while_holding(
        committed_session_factory,
        lambda db: db.execute(select(Visitor).where(Visitor.id == people["visitor_id"]).with_for_update()),
        lambda db: _create_invited_visit(
            VisitsService(db, env), _auth(db, people["host_id"]), people["host_id"], people["visitor_id"]
        ),
        lambda db: VisitorsService(db, env).update(
            _auth(db, people["admin_id"], Role.SYSTEM_ADMIN),
            people["visitor_id"],
            VisitorUpdate(email=new_email),
            SYSTEM_CONTEXT,
        ),
    )
    assert not isinstance(created, (AppError, str)), created
    visit_id = created.payload.visit.id  # type: ignore[attr-defined]
    with committed_session_factory() as db:
        invitations = db.scalars(select(EmailMessage.to_email).where(EmailMessage.visit_id == visit_id)).all()
        assert invitations == [new_email]
        sent_to_old = db.scalars(
            select(EmailMessage.visit_id).where(EmailMessage.to_email == people["old_email"])
        ).all()
        assert sent_to_old == []


def test_a_visit_created_during_its_hosts_deactivation_is_refused(
    committed_session_factory, committed_settings, hasher, people
) -> None:
    """D-18: the deactivation locks the company and the host, then cancels the host's SCHEDULED visits.
    A visit being created meanwhile used to check the host before the deactivation committed and insert
    after it, leaving a SCHEDULED visit with an inactive host that nobody cancelled or announced. (An
    administrator books it here: the host's own booking would be refused even earlier, because the
    deactivation ended the host's session, SEC-07.)"""
    env = service_environment(committed_settings)

    created = _while_holding(
        committed_session_factory,
        lambda db: db.execute(select(Company).where(Company.id == people["company_id"]).with_for_update()),
        lambda db: _create_invited_visit(
            VisitsService(db, env),
            _auth(db, people["admin_id"], Role.SYSTEM_ADMIN),
            people["host_id"],
            people["visitor_id"],
        ),
        lambda db: users_service(db, hasher, committed_settings).update_user(
            _auth(db, people["admin_id"], Role.SYSTEM_ADMIN),
            people["host_id"],
            UserUpdate(is_active=False),
            SYSTEM_CONTEXT,
        ),
    )
    assert isinstance(created, ValidationFailed), created
    assert created.fields == {"host_id": HOST_NOT_AVAILABLE}
    with committed_session_factory() as db:
        hosted = db.scalars(
            select(Visit.status).where(Visit.host_id == people["host_id"], Visit.status == "SCHEDULED")
        ).all()
        assert hosted == []


def test_an_inline_reuse_that_waited_for_another_owners_booking_fills_nothing(
    committed_session_factory, committed_settings, hasher, people
) -> None:
    """§7.5 edit rule, checked again under the visitor lock. The host created the visitor and may edit it
    until an administrator books it for a colleague. A reuse with details to fill in that waited for that
    booking must see it and fill nothing; otherwise the filled-in company also reaches the colleague's
    SCHEDULED visit (D-17)."""
    env = service_environment(committed_settings)
    with committed_session_factory() as db:
        colleague = User(
            company_id=people["company_id"],
            full_name="Booked Colleague",
            email=f"{unique('colleague')}@example.com",
            password_hash=hasher.hash("Committed-Password-1"),
            roles=[Role.EMPLOYEE.value],
        )
        db.add(colleague)
        db.commit()
        colleague_id = colleague.id

    def reuse_with_details(db: Session):
        return VisitsService(db, env).create_visit(
            _auth(db, people["host_id"]),
            VisitCreate.model_validate(
                {
                    "visitor": {
                        "full_name": "Moving Guest",
                        "email": people["old_email"],
                        "phone": "+1 555 0199",
                        "company_name": "Evil Corp",
                    },
                    "host_id": str(people["host_id"]),
                    "purpose": "Race",
                    "scheduled_start": START.isoformat(),
                    "scheduled_end": (START + timedelta(hours=1)).isoformat(),
                    "send_invitation": False,
                }
            ),
            SYSTEM_CONTEXT,
        )

    reused = _while_holding(
        committed_session_factory,
        # The booking's own lock on the visitor (`FOR KEY SHARE`, taken when it chooses the visitor).
        lambda db: db.execute(
            select(Visitor)
            .where(Visitor.id == people["visitor_id"])
            .with_for_update(read=True, key_share=True)
        ),
        reuse_with_details,
        lambda db: _create_invited_visit(
            VisitsService(db, env),
            _auth(db, people["admin_id"], Role.SYSTEM_ADMIN),
            colleague_id,
            people["visitor_id"],
        ),
    )
    assert not isinstance(reused, (AppError, str)), reused
    assert reused.payload.visitor_match.reused is True  # type: ignore[attr-defined]
    with committed_session_factory() as db:
        visitor = db.get(Visitor, people["visitor_id"])
        assert visitor is not None and (visitor.phone, visitor.company_name) == (None, None)
        booked = db.scalars(select(Visit).where(Visit.host_id == colleague_id)).one()
        assert booked.visitor_company_name is None


# ---- moving a visit into a department that changes meanwhile ------------------------------------


def _department_and_admin(
    maker: sessionmaker[Session], company_id: uuid.UUID, hasher
) -> tuple[uuid.UUID, uuid.UUID]:
    with maker() as db:
        department = Department(company_id=company_id, name=unique("Old Name"))
        admin = User(
            company_id=company_id,
            full_name="Race Admin",
            email=f"{unique('admin')}@example.com",
            password_hash=hasher.hash("Committed-Password-1"),
            roles=[Role.SYSTEM_ADMIN.value],
        )
        db.add_all([department, admin])
        db.commit()
        return department.id, admin.id


def _move_while_the_department_changes(
    maker: sessionmaker[Session], scenario: dict, department_id: uuid.UUID, admin_id: uuid.UUID, change
) -> object:
    """The department change holds the locks `DepartmentsService.update` takes first: the company row
    (`FOR UPDATE` when the change names the department, B10-29, else `FOR KEY SHARE`), then the
    department row (`FOR UPDATE`). The PATCH moving the scenario's visit into the department starts and
    must wait (for the company row behind a rename, for the department row behind a deactivation); then
    the change commits."""
    names = change.name is not None or "name_ar" in change.model_fields_set

    def hold(db: Session) -> None:
        company = select(Company).where(Company.id == scenario["company_id"])
        db.execute(company.with_for_update() if names else company.with_for_update(read=True, key_share=True))
        db.execute(select(Department).where(Department.id == department_id).with_for_update())

    return _while_holding(
        maker,
        hold,
        lambda db: VisitsService(db, scenario["env"]).update_visit(
            _auth(db, scenario["host_id"]),
            scenario["visit_id"],
            VisitUpdate(department_id=department_id),
            SYSTEM_CONTEXT,
        ),
        lambda db: DepartmentsService(db, snapshots=VisitSnapshots()).update(
            _auth(db, admin_id, Role.SYSTEM_ADMIN), department_id, change, SYSTEM_CONTEXT
        ),
    )


def test_a_department_renamed_while_a_visit_moves_into_it_names_the_visit(
    committed_session_factory, hasher, scenario
) -> None:
    """D-17: a rename refreshes the snapshots of the department's SCHEDULED visits under the department's
    lock. A PATCH moving a visit into the department used to read the old name without a lock, wait for
    the rename only at its foreign-key check, and commit the old name after the rename had refreshed the
    department's visits (the moving visit was not among them yet)."""
    department_id, admin_id = _department_and_admin(committed_session_factory, scenario["company_id"], hasher)
    moved = _move_while_the_department_changes(
        committed_session_factory, scenario, department_id, admin_id, DepartmentUpdate(name="New Name")
    )
    assert not isinstance(moved, (AppError, str)), moved
    assert moved.payload.department.name == "New Name"  # type: ignore[attr-defined]
    with committed_session_factory() as db:
        visit = db.get(Visit, scenario["visit_id"])
        assert visit is not None and (visit.department_id, visit.department_name) == (
            department_id,
            "New Name",
        )


def test_a_visit_cannot_move_into_a_department_deactivated_meanwhile(
    committed_session_factory, hasher, scenario
) -> None:
    department_id, admin_id = _department_and_admin(committed_session_factory, scenario["company_id"], hasher)
    moved = _move_while_the_department_changes(
        committed_session_factory, scenario, department_id, admin_id, DepartmentUpdate(is_active=False)
    )
    assert isinstance(moved, ValidationFailed), moved
    assert moved.fields == {"department_id": DEPARTMENT_INACTIVE}
    with committed_session_factory() as db:
        visit = db.get(Visit, scenario["visit_id"])
        assert visit is not None and visit.department_id is None
