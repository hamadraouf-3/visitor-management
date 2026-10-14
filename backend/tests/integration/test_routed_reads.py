"""The GET endpoints nginx sends to the read processes (docs/decisions/phase-9-deploy.md D9-34, D9-35).

Each API process keeps its rate limiter in memory. nginx sends six GET endpoints to read processes (two
`backend-reception` replicas and `backend-reports`); every other request, each sign-in and each write
included, reaches the main instance, which runs exactly one process. nginx matches the path exactly as
the client sent it, which is the path the API dispatches on (D9-36), so no other route runs on a read
process; a path that differs from a routed one only in letter case matches no route there. The layout is
sound only while the six endpoints

* consult no rate-limit budget but the per-user API budget (`api_per_user`), whatever they answer. Each
  process counts that budget for the requests it receives; any other budget consulted here would be
  counted once per process, which the security audit's R-1 rules out; and
* write nothing but what an authenticated GET may write: the session's `last_seen_at`, at most once a
  minute and never for `X-Background-Refresh: 1` (contract §7.2), and the NO_SHOW marking that every
  visit-reading call runs (§5). Both are statements on the shared database, the same for one process or
  four.

A refusal also writes its security event (ACCESS_DENIED, RATE_LIMITED). The budget of written refusal
rows (SEC-15) and the coalescing of RATE_LIMITED live in each process's memory, so each process writes
its own: up to 10 ACCESS_DENIED rows and one overflow summary per user and minute, and one RATE_LIMITED
row per user and window plus a deferred summary of the repeats (D9-36). The last tests pin that bound.
"""

from collections import Counter
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import timedelta
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import Connection, Engine, text
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.core.rate_limit import (
    InMemoryRateLimiter,
    LimitKey,
    PolicyName,
    RateDecision,
    RateLimiter,
    RatePolicy,
    Reservation,
)
from app.core.time import FakeClock
from app.email.providers.memory import MemoryProvider
from app.main import create_app
from app.models import Role, User
from app.security.passwords import PasswordHasherService
from app.security.permissions import Capability, has_capability
from app.security.sessions import BACKGROUND_REFRESH_HEADER
from app.services.audit import ATTRIBUTED_ROWS_PER_WINDOW, COALESCE_WINDOW_SECONDS
from tests.conftest import TEST_START
from tests.support import (
    TEST_CLIENT_ADDRESS,
    Factory,
    World,
    audit_rows,
    check_in,
    create_visit,
    error_code,
    rate_limits,
    signed_in,
)

START = TEST_START + timedelta(hours=1)  # 10:00 in Asia/Amman; a one-hour visit's window ends at 12:00

# The routed requests, keyed as the nginx map keys them, with the capability each route requires (the
# roles without it are answered 403). deploy/verify/test_api_instances.py (`EXPECTED_ROUTES`) pins the map
# in deploy/nginx/templates/vms.conf.template to exactly these six keys: a request added to the map must
# be added here too.
ROUTED_READS: dict[str, Capability] = {
    "GET /api/v1/reception/today": Capability.RECEPTION,
    "GET /api/v1/reception/inside": Capability.VIEW_INSIDE,
    "GET /api/v1/reports/summary": Capability.VIEW_REPORTS,
    "GET /api/v1/audit-logs": Capability.READ_AUDIT,
    "GET /api/v1/dashboard/admin": Capability.ADMIN_DASHBOARD,
    "GET /api/v1/visits": Capability.READ_VISITS,
}
# Each routed read with each role allowed to make it.
ALLOWED_READS = [
    (route, role)
    for route, capability in ROUTED_READS.items()
    for role in Role
    if has_capability({role}, capability)
]
# The routed reads that take query parameters: they answer an unknown one with 422 (`extra="forbid"`);
# the others ignore it.
QUERY_READS = frozenset({"GET /api/v1/reports/summary", "GET /api/v1/audit-logs", "GET /api/v1/visits"})
TOUCH = Counter({"user_sessions update": 1})  # the session's `last_seen_at` (contract §7.2)


def _route_id(route: str) -> str:
    return route.removeprefix("GET /api/v1/")


@dataclass(frozen=True)
class LimiterCall:
    method: str
    policy: PolicyName | None  # None for `reset`, which names no budget
    key: str | None


class RecordingLimiter:
    """A `RateLimiter` that records every call, with the budget and key it names, and passes it on to a
    real limiter."""

    def __init__(self, limiter: RateLimiter) -> None:
        self.limiter = limiter
        self.calls: list[LimiterCall] = []

    def check(self, policy: RatePolicy, key: str) -> RateDecision:
        self.calls.append(LimiterCall("check", policy.name, key))
        return self.limiter.check(policy, key)

    def hit(self, policy: RatePolicy, key: str) -> RateDecision:
        self.calls.append(LimiterCall("hit", policy.name, key))
        return self.limiter.hit(policy, key)

    def reserve(self, keys: Sequence[LimitKey]) -> Reservation:
        keys = tuple(keys)
        self.calls.extend(LimiterCall("reserve", limit_key.policy.name, limit_key.key) for limit_key in keys)
        return self.limiter.reserve(keys)

    def settle(self, reservation: Reservation, *, counted: bool) -> Mapping[PolicyName, RateDecision]:
        self.calls.extend(
            LimiterCall("settle", limit_key.policy.name, limit_key.key)
            for limit_key in (*reservation.keys, *reservation.untracked)
        )
        return self.limiter.settle(reservation, counted=counted)

    def clear(self, policy: RatePolicy, key: str) -> None:
        self.calls.append(LimiterCall("clear", policy.name, key))
        self.limiter.clear(policy, key)

    def reset(self) -> None:
        self.calls.append(LimiterCall("reset", None, None))
        self.limiter.reset()


def _api_budget(user: User) -> list[LimiterCall]:
    """What one request may consult: the per-user API budget, keyed by the signed-in user."""
    return [LimiterCall("hit", PolicyName.API_PER_USER, str(user.id))]


@pytest.fixture
def limiter() -> RecordingLimiter:
    return RecordingLimiter(InMemoryRateLimiter())


def _read_process(
    settings: Settings, engine: Engine, hasher: PasswordHasherService, limiter: RateLimiter
) -> FastAPI:
    """An application on the test database, built as a read process is: the same settings, a limiter
    and a security-event coalescer of its own. `create_app` hands the limiter to every collaborator."""
    return create_app(
        settings, engine=engine, password_hasher=hasher, email_provider=MemoryProvider(), rate_limiter=limiter
    )


@pytest.fixture
def read_app(
    settings: Settings,
    app_engine: Engine,
    hasher: PasswordHasherService,
    connection: Connection,
    limiter: RecordingLimiter,
) -> FastAPI:
    """A second application on the test database, with the recording limiter."""
    return _read_process(settings, app_engine, hasher, limiter)


@pytest.fixture
def other_read_app(
    settings: Settings, app_engine: Engine, hasher: PasswordHasherService, connection: Connection
) -> FastAPI:
    """A third application, another read process (the second list replica, say)."""
    return _read_process(settings, app_engine, hasher, InMemoryRateLimiter())


@pytest.fixture
def reception_day(make_client, world: World) -> None:
    """Something for every routed read to show: a visitor inside and one expected later today."""
    host = signed_in(make_client, world.a.employee)
    inside = create_visit(host, world.a.employee.id, START)["visit"]["id"]
    assert check_in(signed_in(make_client, world.a.receptionist), inside).status_code == 200
    create_visit(host, world.a.employee.id, START + timedelta(hours=2))


def _reader(read_app: FastAPI, make_client, user: User) -> TestClient:
    """A client of the read process whose session was signed in on the main instance (the shared
    application), as nginx routes them: no sign-in reaches a read process."""
    main = signed_in(make_client, user)
    return TestClient(
        read_app, base_url="https://testserver", client=TEST_CLIENT_ADDRESS, cookies=main.client.cookies
    )


def _get(client: TestClient, route: str, **kwargs: Any) -> httpx.Response:
    method, path = route.split(" ", 1)
    return client.request(method, path, **kwargs)


def _row_writes(db: Session) -> Counter[str]:
    """The rows this transaction has inserted, updated and deleted so far, per table, as PostgreSQL
    counts them (`pg_stat_xact_user_tables`). Every request of a test joins the test's transaction, and a
    write counts even when it was rolled back to a savepoint afterwards."""
    counts: Counter[str] = Counter()
    statement = text("SELECT relname, n_tup_ins, n_tup_upd, n_tup_del FROM pg_stat_xact_user_tables")
    for table, inserted, updated, deleted in db.execute(statement):
        counts.update({f"{table} insert": inserted, f"{table} update": updated, f"{table} delete": deleted})
    return counts


def _read(db: Session, reader: TestClient, route: str, **kwargs: Any) -> Counter[str]:
    """Make a routed read that must succeed; the rows it wrote."""
    before = _row_writes(db)
    response = _get(reader, route, **kwargs)
    assert response.status_code == 200, response.text
    return _row_writes(db) - before


# ---- rate-limit budgets -------------------------------------------------------------------------


@pytest.mark.parametrize("role", list(Role), ids=lambda role: role.value)
@pytest.mark.parametrize("route", ROUTED_READS, ids=_route_id)
@pytest.mark.usefixtures("reception_day")
def test_a_routed_read_consults_only_the_per_user_api_budget(
    read_app: FastAPI, limiter: RecordingLimiter, make_client, world: World, route: str, role: Role
) -> None:
    user = world.a.users_by_role[role]
    response = _get(_reader(read_app, make_client, user), route)
    # A role without the route's capability is refused after the budget, with 403.
    expected = 200 if has_capability(user.role_set, ROUTED_READS[route]) else 403
    assert response.status_code == expected, response.text
    assert limiter.calls == _api_budget(user)


def test_an_unauthenticated_routed_read_consults_no_budget(
    read_app: FastAPI, limiter: RecordingLimiter
) -> None:
    anonymous = TestClient(read_app, base_url="https://testserver", client=TEST_CLIENT_ADDRESS)
    for route in ROUTED_READS:
        assert _get(anonymous, route).status_code == 401
    assert limiter.calls == []


def test_a_pending_password_change_consults_only_the_per_user_api_budget(
    read_app: FastAPI, limiter: RecordingLimiter, make_client, factory: Factory, world: World
) -> None:
    user = factory.user(world.a.company, roles=(Role.SYSTEM_ADMIN,), must_change_password=True)
    reader = _reader(read_app, make_client, user)
    for route in ROUTED_READS:
        response = _get(reader, route)
        assert response.status_code == 403 and error_code(response) == "PASSWORD_CHANGE_REQUIRED"
    assert limiter.calls == _api_budget(user) * len(ROUTED_READS)


def test_a_spent_per_user_api_budget_is_the_only_budget_a_routed_read_refuses_on(
    read_app: FastAPI, limiter: RecordingLimiter, make_client, world: World
) -> None:
    reader = _reader(read_app, make_client, world.a.admin)
    with rate_limits(read_app, api_per_user=len(ROUTED_READS)):
        for route in ROUTED_READS:
            assert _get(reader, route).status_code == 200
        for route in ROUTED_READS:
            response = _get(reader, route)
            assert response.status_code == 429 and error_code(response) == "RATE_LIMITED"
    assert limiter.calls == _api_budget(world.a.admin) * 2 * len(ROUTED_READS)


@pytest.mark.parametrize("route", ROUTED_READS, ids=_route_id)
def test_an_unknown_query_parameter_consults_only_the_per_user_api_budget(
    read_app: FastAPI, limiter: RecordingLimiter, make_client, world: World, route: str
) -> None:
    # Query parameters are validated after the dependencies, the budget included (app/api/deps.py).
    response = _get(_reader(read_app, make_client, world.a.admin), route, params={"unknown": "1"})
    assert response.status_code == (422 if route in QUERY_READS else 200), response.text
    assert limiter.calls == _api_budget(world.a.admin)


@pytest.mark.parametrize("route", ROUTED_READS, ids=_route_id)
def test_a_background_poll_consults_only_the_per_user_api_budget(
    read_app: FastAPI, limiter: RecordingLimiter, make_client, world: World, route: str
) -> None:
    reader = _reader(read_app, make_client, world.a.admin)
    assert _get(reader, route, headers={BACKGROUND_REFRESH_HEADER: "1"}).status_code == 200
    assert limiter.calls == _api_budget(world.a.admin)


def test_a_routed_path_in_other_letter_case_runs_no_route_on_a_read_process(
    read_app: FastAPI, limiter: RecordingLimiter, make_client, world: World
) -> None:
    # nginx compares its map keys without regard to case and sends these to a read process. The API's
    # routes are case-sensitive: no route runs, so nothing authenticates the session or consults a
    # budget (deploy/verify/test_api_instances.py checks that no other route matches these paths).
    reader = _reader(read_app, make_client, world.a.admin)
    for route in ROUTED_READS:
        method, path = route.split(" ", 1)
        rest = path.removeprefix("/api/v1/")
        for variant in (f"/api/v1/{rest[0].upper()}{rest[1:]}", path.title(), path.upper()):
            assert reader.request(method, variant).status_code == 404, variant
    assert limiter.calls == []


# ---- writes ---------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("route", "role"),
    ALLOWED_READS,
    ids=[f"{_route_id(route)}-{role.value}" for route, role in ALLOWED_READS],
)
@pytest.mark.usefixtures("reception_day")
def test_a_routed_read_writes_only_the_session_touch(
    read_app: FastAPI, make_client, world: World, db: Session, clock: FakeClock, route: str, role: Role
) -> None:
    reader = _reader(read_app, make_client, world.a.users_by_role[role])
    clock.advance(minutes=1)  # the session was last seen a minute ago: this request touches it
    assert _read(db, reader, route) == TOUCH
    assert _read(db, reader, route) == Counter()  # seen within the minute
    clock.advance(minutes=1)
    assert _read(db, reader, route, headers={BACKGROUND_REFRESH_HEADER: "1"}) == Counter()  # a poll


@pytest.mark.parametrize("route", ROUTED_READS, ids=_route_id)
@pytest.mark.usefixtures("reception_day")
def test_a_routed_read_writes_nothing_else_but_the_no_show_marking(
    read_app: FastAPI, make_client, world: World, db: Session, clock: FakeClock, route: str
) -> None:
    host = signed_in(make_client, world.a.employee)
    create_visit(host, world.a.employee.id, START)  # never checked in
    reader = _reader(read_app, make_client, world.a.admin)
    clock.set(START + timedelta(hours=2, minutes=1))  # its window ended a minute ago
    writes = _read(db, reader, route)
    # The visit-reading calls mark it NO_SHOW (§5): one UPDATE of the visit and one audit row per visit.
    marked = len(audit_rows(db, "VISIT_MARKED_NO_SHOW"))
    assert marked <= 1
    assert writes == TOUCH + Counter({"visits update": marked, "audit_logs insert": marked})


# ---- refusal rows, per process (D9-36) ------------------------------------------------------------


def _refusal_rows(db: Session, action: str, user: User) -> tuple[int, list[dict[str, Any]]]:
    """(rows written for single events, the summaries' metadata) of `user`'s `action` rows."""
    rows = audit_rows(db, action, actor_user_id=user.id)
    summaries = [row.meta for row in rows if row.meta.get("deferred")]
    return len(rows) - len(summaries), summaries


def _events_counted(single_rows: int, summaries: list[dict[str, Any]]) -> int:
    """Events the rows account for: a summary is one event plus the `coalesced` others."""
    return single_rows + sum(1 + summary.get("coalesced", 0) for summary in summaries)


def test_each_read_process_writes_its_own_budget_of_access_denied_rows(
    read_app: FastAPI, other_read_app: FastAPI, make_client, world: World, db: Session, clock: FakeClock
) -> None:
    # SEC-15's budget of written ACCESS_DENIED rows per user and window lives in each process's memory:
    # each process writes its own 10 rows and then one overflow summary. Nothing is lost: the summaries
    # carry the count of the rest.
    employee = world.a.employee
    refused = [
        route
        for route, capability in ROUTED_READS.items()
        if not has_capability(employee.role_set, capability)
    ]
    per_process = ATTRIBUTED_ROWS_PER_WINDOW + 5
    for process in (read_app, other_read_app):
        reader = _reader(process, make_client, employee)
        for index in range(per_process):
            assert _get(reader, refused[index % len(refused)]).status_code == 403
    assert _refusal_rows(db, "ACCESS_DENIED", employee) == (2 * ATTRIBUTED_ROWS_PER_WINDOW, [])
    clock.advance(seconds=COALESCE_WINDOW_SECONDS)
    for process in (read_app, other_read_app):
        process.state.security_audit.sweep()  # what each process runs every window
    single, summaries = _refusal_rows(db, "ACCESS_DENIED", employee)
    assert (single, len(summaries)) == (2 * ATTRIBUTED_ROWS_PER_WINDOW, 2)
    assert all(summary["overflow"] for summary in summaries)
    assert _events_counted(single, summaries) == 2 * per_process


def test_each_read_process_coalesces_its_own_rate_limited_refusals(
    read_app: FastAPI, other_read_app: FastAPI, make_client, world: World, db: Session, clock: FakeClock
) -> None:
    # One RATE_LIMITED row per user, budget and window in each process; the repeats are counted into a
    # deferred summary once the window has passed.
    admin = world.a.admin
    refusals = 5
    for process in (read_app, other_read_app):
        reader = _reader(process, make_client, admin)
        with rate_limits(process, api_per_user=1):
            assert _get(reader, "GET /api/v1/reception/today").status_code == 200
            for _ in range(refusals):
                assert _get(reader, "GET /api/v1/reception/today").status_code == 429
    assert _refusal_rows(db, "RATE_LIMITED", admin) == (2, [])
    clock.advance(seconds=COALESCE_WINDOW_SECONDS)
    for process in (read_app, other_read_app):
        process.state.security_audit.sweep()
    single, summaries = _refusal_rows(db, "RATE_LIMITED", admin)
    assert (single, len(summaries)) == (2, 2)
    assert _events_counted(single, summaries) == 2 * refusals
