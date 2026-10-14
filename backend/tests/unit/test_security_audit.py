"""Coalescing of unbounded denials (RATE_LIMITED, CSRF_FAILED) before they reach the audit trail."""

import uuid
from datetime import UTC, datetime

import pytest

from app.core.errors import SecurityEvent
from app.core.request_context import RequestContext
from app.core.time import FakeClock
from app.services.audit import (
    ANONYMOUS_ROWS_PER_WINDOW,
    ATTRIBUTED_ROWS_PER_WINDOW,
    SecurityAudit,
    SecurityEventCoalescer,
)


@pytest.fixture
def fake() -> FakeClock:
    return FakeClock(datetime(2026, 1, 1, tzinfo=UTC))


@pytest.fixture
def coalescer(fake: FakeClock) -> SecurityEventCoalescer:
    return SecurityEventCoalescer(window_seconds=60, clock=fake.now)


def _context(ip: str | None = "203.0.113.5") -> RequestContext:
    return RequestContext(ip_address=ip, user_agent=None, request_id=None)


def _limited(policy: str = "login_failures_ip_email", **values) -> SecurityEvent:
    return SecurityEvent(action="RATE_LIMITED", metadata={"policy": policy}, **values)


def test_first_event_per_window_is_written_and_repeats_are_counted(
    coalescer: SecurityEventCoalescer, fake: FakeClock
) -> None:
    first = coalescer.admit(_limited(), _context())
    assert first is not None and first.metadata == {"policy": "login_failures_ip_email"}
    assert all(coalescer.admit(_limited(), _context()) is None for _ in range(49))

    fake.advance(seconds=60)
    carried = coalescer.admit(_limited(), _context())
    assert carried is not None and carried.metadata == {"policy": "login_failures_ip_email", "coalesced": 49}
    assert coalescer.admit(_limited(), _context()) is None  # a new window has started


def test_keys_are_separate_per_action_policy_and_source(coalescer: SecurityEventCoalescer) -> None:
    assert coalescer.admit(_limited(), _context()) is not None
    assert coalescer.admit(_limited("forgot_password_ip"), _context()) is not None
    assert coalescer.admit(_limited(), _context("203.0.113.6")) is not None
    csrf = SecurityEvent(action="CSRF_FAILED", metadata={"reason": "cross_site"})
    assert coalescer.admit(csrf, _context()) is not None
    user = uuid.uuid4()
    assert coalescer.admit(_limited(actor_user_id=user), _context()) is not None
    assert coalescer.admit(_limited(actor_user_id=user), _context("198.51.100.1")) is None  # same user


def test_unattributed_ipv6_sources_are_grouped_by_48(coalescer: SecurityEventCoalescer) -> None:
    # One site holds a whole /48: rotating through its 65,536 /64s must not buy a row per request.
    assert coalescer.admit(_limited(), _context("2001:db8:1:2::1")) is not None
    assert coalescer.admit(_limited(), _context("2001:db8:1:2::ffff")) is None
    assert coalescer.admit(_limited(), _context("2001:db8:1:3::1")) is None
    assert coalescer.admit(_limited(), _context("2001:db8:1:ffff::1")) is None
    assert coalescer.admit(_limited(), _context("2001:db8:2::1")) is not None  # another site


def test_rotating_64s_of_one_48_write_one_row_and_one_summary(
    coalescer: SecurityEventCoalescer, fake: FakeClock
) -> None:
    csrf = SecurityEvent(action="CSRF_FAILED", metadata={"reason": "origin_not_allowed"})
    admitted = [coalescer.admit(csrf, _context(f"2001:db8:77:{index + 1:x}::1")) for index in range(200)]
    assert sum(event is not None for event in admitted) == 1
    fake.advance(seconds=60)
    coalescer.sweep()
    [(summary, context)] = coalescer.drain()
    assert summary.metadata == {"reason": "origin_not_allowed", "deferred": True, "coalesced": 198}
    assert context.ip_address == "2001:db8:77:c8::1"


def test_unattributed_events_share_a_budget_across_sources(
    coalescer: SecurityEventCoalescer, fake: FakeClock
) -> None:
    # Many IPv4 addresses (or many /48s) each look new; together they still get ten rows a window.
    admitted = [
        coalescer.admit(_limited(), _context(f"10.{index // 250}.{index % 250}.1")) for index in range(200)
    ]
    assert sum(event is not None for event in admitted) == ANONYMOUS_ROWS_PER_WINDOW == 10
    fake.advance(seconds=60)
    coalescer.sweep()
    [(summary, context)] = coalescer.drain()
    assert summary.metadata == {
        "policy": "login_failures_ip_email",
        "deferred": True,
        "overflow": True,
        "coalesced": 189,  # 190 held back: the summary row is one of them
    }
    assert context.ip_address == "10.0.199.1"
    assert coalescer.admit(_limited(), _context("10.9.9.9")) is not None  # a new window, a new budget


def test_budget_is_per_action_and_kind(coalescer: SecurityEventCoalescer) -> None:
    for index in range(ANONYMOUS_ROWS_PER_WINDOW):
        assert coalescer.admit(_limited(), _context(f"10.0.0.{index}")) is not None
    assert coalescer.admit(_limited(), _context("10.0.1.1")) is None
    assert coalescer.admit(_limited("forgot_password_ip"), _context("10.0.1.1")) is not None
    csrf = SecurityEvent(action="CSRF_FAILED", metadata={"reason": "cross_site"})
    assert coalescer.admit(csrf, _context("10.0.1.1")) is not None


def test_attributed_events_do_not_spend_the_anonymous_budget(coalescer: SecurityEventCoalescer) -> None:
    for index in range(ANONYMOUS_ROWS_PER_WINDOW):
        coalescer.admit(_limited(), _context(f"10.0.0.{index}"))
    assert coalescer.admit(_limited(), _context("10.0.1.1")) is None
    assert coalescer.admit(_limited(actor_user_id=uuid.uuid4()), _context("10.0.1.1")) is not None


def test_overflow_summary_is_written_when_the_next_window_starts(
    coalescer: SecurityEventCoalescer, fake: FakeClock
) -> None:
    for index in range(ANONYMOUS_ROWS_PER_WINDOW + 3):
        coalescer.admit(_limited(), _context(f"10.0.0.{index}"))
    fake.advance(seconds=30)
    coalescer.admit(_limited(), _context("10.0.1.1"))  # still inside the budget's window
    assert coalescer.drain() == []
    fake.advance(seconds=31)
    coalescer.admit(_limited(), _context("10.0.2.1"))  # a new budget window: the old overflow is written
    [(summary, _)] = coalescer.drain()
    assert summary.metadata["overflow"] is True and summary.metadata["coalesced"] == 3


def test_count_of_a_source_held_back_by_the_budget_is_not_lost(
    coalescer: SecurityEventCoalescer, fake: FakeClock
) -> None:
    coalescer.admit(_limited(), _context("10.0.0.1"))
    coalescer.admit(_limited(), _context("10.0.0.1"))  # one repeat, to be carried by its next row
    fake.advance(seconds=30)
    coalescer.sweep()  # nothing has expired; the next time-driven sweep is a window away
    fake.advance(seconds=30)
    for index in range(ANONYMOUS_ROWS_PER_WINDOW):  # spend the new window's budget
        coalescer.admit(_limited(), _context(f"10.0.9.{index}"))
    assert coalescer.admit(_limited(), _context("10.0.0.1")) is None  # over budget: cannot carry it
    [(summary, context)] = coalescer.drain()
    assert summary.metadata == {"policy": "login_failures_ip_email", "deferred": True}
    assert context.ip_address == "10.0.0.1"


def test_anonymous_budget_must_allow_a_row() -> None:
    with pytest.raises(ValueError, match="at least 1"):
        SecurityEventCoalescer(anonymous_rows_per_window=0)


@pytest.mark.parametrize("action", ["AUTH_LOGIN_FAILED", "ACCESS_DENIED", "AUTH_PASSWORD_RESET_FAILED"])
def test_bounded_events_are_never_coalesced(coalescer: SecurityEventCoalescer, action: str) -> None:
    event = SecurityEvent(action=action, metadata={"reason": "bad_password"})
    assert all(coalescer.admit(event, _context()) is event for _ in range(5))


def test_reset_forgets_windows(coalescer: SecurityEventCoalescer) -> None:
    coalescer.admit(_limited(), _context())
    coalescer.reset()
    assert coalescer.admit(_limited(), _context()) is not None


def test_expired_windows_are_swept_by_time(coalescer: SecurityEventCoalescer, fake: FakeClock) -> None:
    for index in range(ANONYMOUS_ROWS_PER_WINDOW):
        coalescer.admit(_limited(), _context(f"10.0.0.{index}"))
    coalescer.admit(_limited(), _context("10.0.0.1"))  # one repeat inside its window
    fake.advance(seconds=61)
    coalescer.admit(_limited(), _context("192.0.2.1"))  # a window later: this admission sweeps
    assert len(coalescer._windows) == 1
    [(summary, context)] = coalescer.drain()
    assert summary.metadata == {"policy": "login_failures_ip_email", "deferred": True}
    assert context.ip_address == "10.0.0.1"
    assert coalescer.drain() == []  # each summary is handed out once


def test_sweep_waits_a_window_between_runs(coalescer: SecurityEventCoalescer, fake: FakeClock) -> None:
    def key(ip: str) -> tuple[str, str, str]:
        return ("RATE_LIMITED", ip, "login_failures_ip_email")

    coalescer.admit(_limited(), _context("10.0.0.1"))
    fake.advance(seconds=50)
    coalescer.admit(_limited(), _context("10.0.0.2"))
    fake.advance(seconds=11)
    coalescer.admit(_limited(), _context("10.0.0.3"))  # a window after creation: sweeps window 1
    assert set(coalescer._windows) == {key("10.0.0.2"), key("10.0.0.3")}
    fake.advance(seconds=50)
    coalescer.admit(_limited(), _context("10.0.0.4"))  # window 2 expired, but the last sweep is recent
    assert set(coalescer._windows) == {key("10.0.0.2"), key("10.0.0.3"), key("10.0.0.4")}
    fake.advance(seconds=10)
    coalescer.admit(_limited(), _context("10.0.0.5"))  # a window after the last sweep: 2 and 3 go
    assert set(coalescer._windows) == {key("10.0.0.4"), key("10.0.0.5")}


def test_summary_counts_every_suppressed_event(coalescer: SecurityEventCoalescer, fake: FakeClock) -> None:
    coalescer.admit(_limited(), _context())
    for index in range(5):
        coalescer.admit(
            _limited(), RequestContext(ip_address="203.0.113.5", user_agent=None, request_id=f"r{index}")
        )
    fake.advance(seconds=60)
    coalescer.sweep()
    [(summary, context)] = coalescer.drain()
    # The row is the last suppressed event; `coalesced` counts the other four.
    assert summary.metadata == {"policy": "login_failures_ip_email", "deferred": True, "coalesced": 4}
    assert context.request_id == "r4"


def test_flush_writes_open_windows_regardless_of_age(coalescer: SecurityEventCoalescer) -> None:
    csrf = SecurityEvent(action="CSRF_FAILED", metadata={"reason": "cross_site", "method": "POST"})
    coalescer.admit(csrf, _context())
    coalescer.admit(csrf, _context())
    coalescer.admit(_limited(), _context("198.51.100.1"))  # nothing suppressed: nothing to write
    coalescer.flush()
    [(summary, _)] = coalescer.drain()
    assert summary.action == "CSRF_FAILED"
    assert summary.metadata == {"reason": "cross_site", "method": "POST", "deferred": True}
    assert coalescer._windows == {}


def test_carried_count_is_not_written_twice(coalescer: SecurityEventCoalescer, fake: FakeClock) -> None:
    coalescer.admit(_limited(), _context())
    coalescer.admit(_limited(), _context())
    fake.advance(seconds=61)
    carried = coalescer.admit(_limited(), _context())  # the same key picks the count up first
    assert carried is not None and carried.metadata["coalesced"] == 1
    coalescer.flush()
    assert coalescer.drain() == []


class _Recorder:
    def __init__(self) -> None:
        self.rows: list[tuple[SecurityEvent, RequestContext]] = []

    def __call__(self, event: SecurityEvent, context: RequestContext) -> bool:
        self.rows.append((event, context))
        return True


def test_security_audit_writes_summaries_on_sweep_and_flush(fake: FakeClock) -> None:
    recorder = _Recorder()
    audit = SecurityAudit(SecurityEventCoalescer(window_seconds=60, clock=fake.now), writer=recorder)
    audit.record(_limited(), _context("10.0.0.1"))
    audit.record(_limited(), _context("10.0.0.1"))
    audit.record(_limited(), _context("10.0.0.2"))
    audit.record(_limited(), _context("10.0.0.2"))
    assert len(recorder.rows) == 2  # first event per source
    fake.advance(seconds=61)
    audit.sweep()
    assert [row[1].ip_address for row in recorder.rows[2:]] == ["10.0.0.1", "10.0.0.2"]
    audit.record(_limited(), _context("10.0.0.3"))
    audit.record(_limited(), _context("10.0.0.3"))
    audit.flush()  # shutdown: the open window is written although it has not expired
    assert recorder.rows[-1][1].ip_address == "10.0.0.3"
    assert recorder.rows[-1][0].metadata["deferred"] is True
    assert len(recorder.rows) == 6


# ---- attributed refusals: a budget of written rows per user (SEC-15) ------------------------------


def _denied(user: uuid.UUID, route: str = "/api/v1/users") -> SecurityEvent:
    return SecurityEvent(
        action="ACCESS_DENIED", actor_user_id=user, metadata={"method": "GET", "route": route}
    )


def test_a_users_refusals_are_written_up_to_the_budget_then_summarised(
    coalescer: SecurityEventCoalescer, fake: FakeClock
) -> None:
    user, other = uuid.uuid4(), uuid.uuid4()
    written = [coalescer.admit(_denied(user, f"/api/v1/r{index}"), _context()) for index in range(15)]
    assert all(event is not None for event in written[:ATTRIBUTED_ROWS_PER_WINDOW])
    assert written[ATTRIBUTED_ROWS_PER_WINDOW:] == [None] * (15 - ATTRIBUTED_ROWS_PER_WINDOW)
    assert written[3] is not None and written[3].metadata == {"method": "GET", "route": "/api/v1/r3"}  # as is
    # Another user, and another action of the same user, have budgets of their own.
    assert coalescer.admit(_denied(other), _context()) is not None
    link = SecurityEvent(
        action="VISITOR_LINK_REFUSED", actor_user_id=user, metadata={"code": "VISITOR_EXISTS"}
    )
    assert coalescer.admit(link, _context()) is not None

    fake.advance(seconds=61)
    coalescer.sweep()
    [(summary, _)] = coalescer.drain()
    assert summary.actor_user_id == user
    assert summary.metadata == {
        "method": "GET",
        "route": "/api/v1/r14",
        "deferred": True,
        "overflow": True,
        "coalesced": 15 - ATTRIBUTED_ROWS_PER_WINDOW - 1,
    }
    assert coalescer.admit(_denied(user), _context()) is not None  # a new window


def test_unbudgeted_attributed_events_are_written_every_time(coalescer: SecurityEventCoalescer) -> None:
    user = uuid.uuid4()
    failed = SecurityEvent(action="AUTH_PASSWORD_CHANGE_FAILED", actor_user_id=user, metadata={"reason": "x"})
    assert all(coalescer.admit(failed, _context()) is failed for _ in range(ATTRIBUTED_ROWS_PER_WINDOW + 5))
