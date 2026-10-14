"""Visit views of the reception lists (re-audit round 1: GET /reception/today's CPU per poll).

The reception lists read their visits as plain `VisitRecord` rows instead of ORM entities, and the view
builder's lookups bind each batch of IDs as one array parameter instead of an IN list with one parameter
per ID. These tests pin what must not change with that: a view built from a record is the view built from
the entity, in every state and for every kind of caller; and the reception day runs the same statements
whatever the number of visits on it.
"""

from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from sqlalchemy import Connection, event
from sqlalchemy.orm import Session

from app.core.time import FakeClock, company_day_bounds, local_date
from app.models import Visit
from app.repositories.visits import VisitRecord, VisitRepository
from app.schemas.reception import LIST_CAP
from app.services.visit_rules import Caller
from app.services.visit_views import Viewer, VisitViewBuilder
from tests.support import Api, World, check_in, check_out, create_visit, signed_in, walk_in_body

MORNING = datetime(2026, 10, 6, 6, 0, tzinfo=UTC)  # 6 October, 09:00 in Asia/Amman


def _guest(name: str) -> dict[str, str]:
    return {"full_name": name, "email": f"{name.lower().replace(' ', '.')}@example.com"}


def _a_day_in_every_state(world: World, clock: FakeClock, make_client: Any) -> None:
    """Yesterday's visitor still inside (stale), today's expected (one with a department and an
    invitation, one whose pass was rotated), inside (overdue), checked out, cancelled (with its notice),
    no-show, and a walk-in."""
    employee = world.a.employee
    host = signed_in(make_client, employee)
    left_over = create_visit(host, employee.id, MORNING - timedelta(hours=23), visitor=_guest("Left Over"))
    assert check_in(signed_in(make_client, world.a.receptionist), left_over["visit"]["id"]).status_code == 200
    clock.set(MORNING)
    host = signed_in(make_client, employee)
    reception = signed_in(make_client, world.a.receptionist)
    at_ten = MORNING + timedelta(hours=1)
    create_visit(
        host,
        employee.id,
        at_ten,
        visitor=_guest("Invited Guest"),
        send_invitation=True,
        department_id=str(world.a.finance.id),
    )
    rotated = create_visit(host, employee.id, at_ten + timedelta(hours=2), visitor=_guest("Rotated Guest"))
    assert host.post(f"/visits/{rotated['visit']['id']}/pass").status_code == 200
    inside = create_visit(host, employee.id, MORNING + timedelta(minutes=10), visitor=_guest("Inside Guest"))
    gone = create_visit(host, employee.id, at_ten, visitor=_guest("Gone Guest"))
    cancelled = create_visit(host, employee.id, at_ten, visitor=_guest("Cancelled Guest"))
    create_visit(host, employee.id, MORNING + timedelta(minutes=5), visitor=_guest("No Show"))
    assert host.post(f"/visits/{cancelled['visit']['id']}/cancel", json={}).status_code == 200
    assert check_in(reception, inside["visit"]["id"]).status_code == 200
    assert check_in(reception, gone["visit"]["id"]).status_code == 200
    assert check_out(reception, gone["visit"]["id"]).status_code == 200
    walk_in = reception.post(
        "/reception/walk-ins", json=walk_in_body(employee.id, MORNING + timedelta(hours=4))
    )
    assert walk_in.status_code == 201
    clock.set(MORNING + timedelta(hours=2, minutes=10))  # 11:10: the 09:05 visit is a no-show
    today = signed_in(make_client, world.a.receptionist).get("/reception/today")  # marks the no-show
    assert today.status_code == 200, today.text


def _records(db: Session, world: World, now: datetime) -> list[VisitRecord]:
    """The four reception lists, as GET /reception/today reads them."""
    repository = VisitRepository(db)
    company_id, timezone = world.a.company.id, world.a.company.timezone
    start, end = company_day_bounds(local_date(now, timezone), timezone)
    return [
        *repository.expected_until(company_id, end, limit=LIST_CAP),
        *repository.inside(company_id, limit=LIST_CAP),
        *repository.checked_out_between(company_id, start, end, limit=LIST_CAP),
        *repository.no_shows_starting_between(company_id, start, end, limit=LIST_CAP),
    ]


def test_a_view_from_a_record_is_the_view_from_the_entity(
    world: World, clock: FakeClock, make_client: Any, db: Session
) -> None:
    _a_day_in_every_state(world, clock, make_client)
    now = clock.now()
    records = _records(db, world, now)
    statuses = {record.status for record in records}
    assert statuses == {"SCHEDULED", "CHECKED_IN", "CHECKED_OUT", "NO_SHOW"} and len(records) == 7
    db.expire_all()
    entities = [db.get(Visit, record.id) for record in records]
    assert all(entity is not None for entity in entities)
    for user in (world.a.receptionist, world.a.employee, world.a.admin, world.a.manager):
        viewer = Viewer(
            caller=Caller(user_id=user.id, roles=user.role_set),
            company_id=world.a.company.id,
            timezone=world.a.company.timezone,
        )
        builder = VisitViewBuilder(db, viewer, now=now)
        from_records = [view.model_dump(mode="json", by_alias=True) for view in builder.build(records)]
        from_entities = [view.model_dump(mode="json", by_alias=True) for view in builder.build(entities)]  # type: ignore[arg-type]
        assert from_records == from_entities, user.email
        assert {view["invitation"]["status"] for view in from_records} >= {"NOT_SENT", "SENT"}
        assert {view["pass"]["status"] for view in from_records} >= {"ACTIVE", "REVOKED", "EXPIRED"}
        assert any(view["is_stale"] for view in from_records) and any(
            view["department"] for view in from_records
        )
    # The cancelled visit is in no reception list; its notice is shown on the visit itself.
    assert "Cancelled Guest" not in str(from_records)


@pytest.fixture
def statements(connection: Connection) -> Any:
    """The SQL text of every statement run on the test connection while the context is active."""

    class Recorder:
        def __init__(self) -> None:
            self.texts: list[str] = []

        def __enter__(self) -> list[str]:
            event.listen(connection, "before_cursor_execute", self._record)
            return self.texts

        def __exit__(self, *exc: object) -> None:
            event.remove(connection, "before_cursor_execute", self._record)

        def _record(self, conn, cursor, statement: str, parameters, context, executemany: bool) -> None:
            self.texts.append(statement)

    return Recorder


def _lookups(texts: list[str]) -> list[str]:
    """The statements that read the reception lists and their visits' users, e-mails, passes and
    visitors."""
    tables = ("FROM visits", "FROM users", "FROM email_messages", "FROM visitor_passes", "FROM visitors")
    return [text for text in texts if text.lstrip().startswith("SELECT") and any(t in text for t in tables)]


def test_the_reception_day_runs_the_same_statements_whatever_its_size(
    world: World, clock: FakeClock, make_client: Any, statements: Any
) -> None:
    """With IN lists, each lookup's SQL had one parameter per visit, so it differed with the day's size:
    SQLAlchemy rendered it and psycopg parsed it again on every poll (too long for psycopg's cache)."""
    employee = world.a.employee
    host = signed_in(make_client, employee)
    reception: Api = signed_in(make_client, world.a.receptionist)

    def add(count: int) -> None:
        for index in range(count):
            create_visit(host, employee.id, clock.now() + timedelta(hours=1, minutes=index))

    add(2)
    with statements() as small:
        assert reception.get("/reception/today").json()["counts"]["expected"] == 2
    add(5)
    with statements() as large:
        assert reception.get("/reception/today").json()["counts"]["expected"] == 7
    assert _lookups(small) and _lookups(small) == _lookups(large)
