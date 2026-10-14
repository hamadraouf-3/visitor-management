"""Volume and latency checks (opt-in: `pytest --performance -s tests/performance`).

A throwaway database is seeded with 20,000 visitors and 60,000 visits with their passes, e-mails and
audit trail, and an ordinary busy reception day (`volume.seed_volume`). Then:

* the SQL the real endpoints run is captured (SQLAlchemy `before_cursor_execute`) and explained with
  `EXPLAIN (ANALYZE, BUFFERS)`: visitor search must use the trigram indexes (contract §4), no list of
  visits may read every pass ever issued (`Seq Scan on visitor_passes`), the audit log's date filter
  must not read the whole audit trail, the year-long report must not spill to disk, and every endpoint's
  median time is reported;
* GET /reception/today, which every reception tablet polls, is timed over 50 requests on that day;
* scan and QR check-in are timed over 50 fresh visits each, through the whole application stack (ASGI,
  middleware, authentication, services); their 95th percentiles, and the reception day's, must stay
  below 300 ms (§11).

The numbers are printed (run with `-s`) and recorded in docs/decisions/phase-5-7-backend.md. They are not
part of the default run: timing assertions belong on a quiet machine, and seeding takes a while.
"""

import statistics
import sys
import time
from collections.abc import Callable, Iterator
from datetime import timedelta
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine, event

from app.core.config import Settings
from app.db.session import create_db_engine, make_sessionmaker, session_factory
from app.email.providers.memory import MemoryProvider
from app.main import create_app
from app.security.passwords import PasswordHasherService
from tests.conftest import TEST_START, _migrated, _test_settings
from tests.performance.volume import SeededVolume, seed_volume
from tests.support import DEFAULT_PASSWORD, TEST_CLIENT_ADDRESS, Api, ThrowawayDatabase

pytestmark = pytest.mark.performance

ITERATIONS = 50
P95_BUDGET_MS = 300.0
SLOW_SQL_MS = 20.0  # statements slower than this are printed with their plans
TRIGRAM_INDEXES = ("ix_visitors_search_text_trgm", "ix_visitors_phone_digits_trgm")


@pytest.fixture(scope="module")
def volume_database(create_database) -> ThrowawayDatabase:
    return _migrated(create_database, "vms_volume")


@pytest.fixture(scope="module")
def volume_settings(volume_database: ThrowawayDatabase) -> Settings:
    # Rate limiting stays on: its cost is part of every real request (the checks stay within the budgets).
    return _test_settings(volume_database)


@pytest.fixture(scope="module")
def volume(volume_database: ThrowawayDatabase, hasher: PasswordHasherService) -> SeededVolume:
    owner = create_db_engine(volume_database.owner_url, pool_size=1, application_name="vms-volume-seed")
    try:
        started = time.perf_counter()
        seeded = seed_volume(owner, now=TEST_START, password_hash=hasher.hash(DEFAULT_PASSWORD))
        elapsed = time.perf_counter() - started
        print(
            f"\nseeded {seeded.visitors} visitors / {seeded.visits} visits / {seeded.passes} passes / "
            f"{seeded.emails} e-mails / {seeded.audit_rows} audit rows in {elapsed:.1f} s"
        )
        return seeded
    finally:
        owner.dispose()


@pytest.fixture(scope="module")
def volume_engine(volume_settings: Settings) -> Iterator[Engine]:
    engine = create_db_engine(volume_settings.runtime_url, pool_size=5, application_name="vms-volume")
    yield engine
    engine.dispose()


@pytest.fixture
def volume_client(
    volume_settings: Settings, volume_engine: Engine, volume: SeededVolume, hasher: PasswordHasherService
) -> Iterator[Callable[[str], Api]]:
    app = create_app(
        volume_settings, engine=volume_engine, password_hasher=hasher, email_provider=MemoryProvider()
    )
    session_factory.override(make_sessionmaker(volume_engine))
    try:

        def signed_in(email: str) -> Api:
            api = Api(TestClient(app, base_url="https://testserver", client=TEST_CLIENT_ADDRESS))
            assert api.login(email).status_code == 200
            return api

        yield signed_in
    finally:
        session_factory.clear_override()


class StatementLog:
    """The SELECT statements an engine runs (with their parameters) while active, and the `SET LOCAL`s
    between them (the serial audit count, `repositories.pagination`), so that their plans are explained
    as they ran."""

    def __init__(self, engine: Engine) -> None:
        self.engine = engine
        self.statements: list[tuple[str, Any]] = []

    def __enter__(self) -> StatementLog:
        event.listen(self.engine, "before_cursor_execute", self._record)
        return self

    def __exit__(self, *exc: object) -> None:
        event.remove(self.engine, "before_cursor_execute", self._record)

    def _record(self, conn, cursor, statement: str, parameters: Any, context, executemany: bool) -> None:
        head = statement.lstrip().upper()
        if (head.startswith("SELECT") and "pg_backend_pid" not in statement) or head.startswith("SET LOCAL"):
            self.statements.append((statement, parameters))


def _explain(engine: Engine, statements: list[tuple[str, Any]]) -> list[tuple[str, float]]:
    """`EXPLAIN (ANALYZE, BUFFERS)` of each SELECT with its execution time, in one transaction that also
    runs the `SET LOCAL`s in their places."""
    explained = []
    with engine.connect() as connection:
        raw = connection.connection.dbapi_connection
        assert raw is not None
        with raw.cursor() as cursor:
            for statement, parameters in statements:
                if statement.lstrip().upper().startswith("SET LOCAL"):
                    cursor.execute(statement, parameters)
                    continue
                cursor.execute("EXPLAIN (ANALYZE, BUFFERS) " + statement, parameters)
                plan = "\n".join(row[0] for row in cursor.fetchall())
                explained.append((plan, float(plan.rsplit("Execution Time: ", 1)[1].split(" ms")[0])))
        connection.rollback()
    return explained


def _print(text: str) -> None:
    """Print, escaping what a console in a legacy code page cannot show (Arabic search terms in plans)."""
    encoding = sys.stdout.encoding or "utf-8"
    print(text.encode(encoding, errors="backslashreplace").decode(encoding))


def _median_ms(call: Callable[[], Any], repeat: int = 5) -> float:
    samples = []
    for _ in range(repeat):
        started = time.perf_counter()
        call()
        samples.append((time.perf_counter() - started) * 1000)
    return statistics.median(samples)


def _p95(samples: list[float]) -> float:
    return statistics.quantiles(samples, n=100, method="inclusive")[94]


def test_queries_use_their_indexes_and_stay_fast(
    volume_client, volume: SeededVolume, volume_engine: Engine
) -> None:
    admin = volume_client(volume.admin_email)
    host_id = str(volume.host_id)
    endpoints = {
        f"visitors q={volume.surname}": ("/visitors", {"q": volume.surname}),
        "visitors q=sa (two characters)": ("/visitors", {"q": "sa"}),
        f"visitors q={volume.phone_query} (phone)": ("/visitors", {"q": volume.phone_query}),
        "visitors q=<Arabic surname>": ("/visitors", {"q": volume.arabic_name}),
        "visitors (no query, first page)": ("/visitors", {}),
        f"visits scope=all q={volume.surname}": ("/visits", {"scope": "all", "q": volume.surname}),
        f"visits scope=all q={volume.rare_surname} (rare)": (
            "/visits",
            {"scope": "all", "q": volume.rare_surname},
        ),
        f"visits scope=all q={volume.phone_query} (phone)": (
            "/visits",
            {"scope": "all", "q": volume.phone_query},
        ),
        "visits scope=all q=<Arabic surname>": ("/visits", {"scope": "all", "q": volume.arabic_name}),
        "visits scope=all q=sa (two characters)": ("/visits", {"scope": "all", "q": "sa"}),
        "visits scope=all status+30 days": (
            "/visits",
            {
                "scope": "all",
                "status": "CHECKED_OUT,NO_SHOW",
                "date_from": "2026-09-05",
                "date_to": "2026-10-05",
            },
        ),
        "visits scope=all host": ("/visits", {"scope": "all", "host_id": host_id}),
        "visits scope=all (first page)": ("/visits", {"scope": "all"}),
        "reception today": ("/reception/today", {}),
        "reception inside": ("/reception/inside", {}),
        "visits needs attention": ("/visits", {"scope": "all", "needs_attention": "true"}),
        "visitor history": (f"/visitors/{volume.history_visitor_id}/visits", {}),
        "reports summary (30 days)": ("/reports/summary", {}),
        "reports summary (366 days)": (
            "/reports/summary",
            {"date_from": "2025-10-05", "date_to": "2026-10-05"},
        ),
        "audit logs (first page)": ("/audit-logs", {}),
        "audit logs action": ("/audit-logs", {"action": "VISIT_CREATED"}),
        "audit logs 7 days": ("/audit-logs", {"date_from": "2026-09-28", "date_to": "2026-10-05"}),
        "audit logs page 1000": ("/audit-logs", {"page": "1000"}),
        "admin dashboard": ("/dashboard/admin", {}),
    }
    report: list[str] = ["", f"{'endpoint':55} {'median ms':>10} {'slowest SQL ms':>15}"]
    plans: dict[str, list[str]] = {}
    slow_plans: list[str] = []
    for name, (path, params) in endpoints.items():
        response = admin.get(path, params=params)
        assert response.status_code == 200, (name, response.text)
        median = _median_ms(lambda path=path, params=params: admin.get(path, params=params))
        with StatementLog(volume_engine) as log:
            admin.get(path, params=params)
        explained = _explain(volume_engine, log.statements)
        plans[name] = [plan for plan, _ in explained]
        slowest = max((ms for _, ms in explained), default=0.0)
        report.append(f"{name:55} {median:10.1f} {slowest:15.2f}")
        slow_plans += [f"--- {name} ({ms:.1f} ms)\n{plan}" for plan, ms in explained if ms > SLOW_SQL_MS]
    _print("\n".join(report))
    _print(f"\nStatements over {SLOW_SQL_MS:.0f} ms:\n" + "\n\n".join(slow_plans))
    # Every list of visits looks up the current pass of the visits on its page through the
    # (company_id, visit_id) index (revision 0010), never by reading every pass ever issued.
    for name, statements in plans.items():
        assert not any("Seq Scan on visitor_passes" in plan for plan in statements), (name, statements)
    assert not any("Seq Scan on audit_logs" in plan for plan in plans["audit logs 7 days"])
    # A full audit page counts the company's whole trail, without parallel workers: on this host their
    # start-up cost more than they saved (re-audit round 1).
    for name in ("audit logs (first page)", "audit logs page 1000"):
        counts = [plan for plan in plans[name] if "Aggregate" in plan]
        assert counts and not any("Gather" in plan for plan in counts), (name, plans[name])
    assert not any("Disk:" in plan for plan in plans["reports summary (366 days)"])
    for name in [key for key in plans if key.startswith("visitors q=") and "two characters" not in key]:
        assert any(index in plan for plan in plans[name] for index in TRIGRAM_INDEXES), (name, plans[name])
    # The history search finds its visits through indexes (snapshot trigrams, then the matching visitors'
    # visits), never by reading every visit of the company. A one- or two-character query has no trigram
    # to use and reads the company's visits, as it did before revision 0007.
    history = [key for key in plans if key.startswith("visits scope=all q=") and "two characters" not in key]
    for name in history:
        assert not any("Seq Scan on visits" in plan for plan in plans[name]), (name, plans[name])
    # The plans of the searches, for the record.
    for name in (
        f"visitors q={volume.surname}",
        f"visitors q={volume.phone_query} (phone)",
        f"visits scope=all q={volume.surname}",
        f"visits scope=all q={volume.rare_surname} (rare)",
        f"visits scope=all q={volume.phone_query} (phone)",
    ):
        _print(f"\n--- {name}\n" + "\n\n".join(plans[name]))


def test_reception_day_p95(volume_client, volume: SeededVolume) -> None:
    """GET /reception/today on an ordinary busy day, as a reception tablet polls it."""
    reception = volume_client(volume.reception_email)
    first = reception.get("/reception/today")
    assert first.status_code == 200, first.text
    today = first.json()
    mix = volume.today
    assert today["counts"]["expected"] == mix.expected and today["counts"]["inside"] == mix.inside
    assert today["counts"]["checked_out"] == mix.checked_out and today["counts"]["no_show"] == mix.no_show
    samples = []
    cpu_started = time.process_time()
    for _ in range(ITERATIONS):
        started = time.perf_counter()
        assert reception.get("/reception/today").status_code == 200
        samples.append((time.perf_counter() - started) * 1000)
    # The CPU each poll costs this process (the test client's share included, PostgreSQL's not): what
    # limits how many tablets one API process serves (re-audit round 1).
    cpu_ms = (time.process_time() - cpu_started) / ITERATIONS * 1000
    print(
        f"\nreception today ({len(first.content)} bytes): median {statistics.median(samples):6.1f} ms  "
        f"p95 {_p95(samples):6.1f} ms  max {max(samples):6.1f} ms  CPU {cpu_ms:5.1f} ms per request  "
        f"({ITERATIONS} iterations)"
    )
    assert _p95(samples) < P95_BUDGET_MS


def test_scan_and_check_in_p95(volume_client, volume: SeededVolume) -> None:
    host = volume_client(volume.host_email)
    reception = volume_client(volume.reception_email)
    created = []
    for index in range(ITERATIONS):
        body = {
            "visitor": {"full_name": f"Latency Guest {index}", "email": f"latency{index}@example.com"},
            "host_id": str(volume.host_id),
            "purpose": "Latency check",
            "scheduled_start": (TEST_START + timedelta(minutes=30)).isoformat(),
            "scheduled_end": (TEST_START + timedelta(minutes=90)).isoformat(),
            "send_invitation": False,
        }
        response = host.post("/visits", json=body)
        assert response.status_code == 201, response.text
        created.append(response.json())
    scans, check_ins = [], []
    for visit in created:
        started = time.perf_counter()
        scanned = reception.post("/reception/scan", json={"token": visit["pass_url"]})
        scans.append((time.perf_counter() - started) * 1000)
        assert scanned.status_code == 200 and scanned.json()["result"] == "READY", scanned.text
        started = time.perf_counter()
        checked_in = reception.post(
            f"/visits/{visit['visit']['id']}/check-in", json={"method": "QR", "pass_token": visit["pass_url"]}
        )
        check_ins.append((time.perf_counter() - started) * 1000)
        assert checked_in.status_code == 200, checked_in.text
    for label, samples in (("scan", scans), ("check-in", check_ins)):
        print(
            f"\n{label:9} median {statistics.median(samples):6.1f} ms  p95 {_p95(samples):6.1f} ms"
            f"  max {max(samples):6.1f} ms  ({ITERATIONS} iterations)"
        )
    assert _p95(scans) < P95_BUDGET_MS
    assert _p95(check_ins) < P95_BUDGET_MS
