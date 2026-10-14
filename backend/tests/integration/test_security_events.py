"""Failure/denial audit rows (§7.4) that must not be lost: coalesced counts at shutdown (B1-33/B1-55),
and events whose request carries a value PostgreSQL cannot store (B1-57)."""

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.core.errors import SecurityEvent
from app.core.request_context import RequestContext
from app.services.audit import record_security_event
from tests.support import API, DEFAULT_PASSWORD, Api, World, audit_rows, error_code


def _cross_site_post(client: TestClient) -> int:
    return client.post(
        f"{API}/auth/login",
        json={"email": "someone@x.test", "password": "irrelevant-password"},
        headers={"Sec-Fetch-Site": "cross-site"},
    ).status_code


def test_coalesced_counts_are_written_when_the_application_stops(
    app: FastAPI, connection, db: Session
) -> None:
    with TestClient(app, base_url="https://testserver", client=("198.51.100.40", 1234)) as client:
        assert [_cross_site_post(client) for _ in range(4)] == [403] * 4
        assert len(audit_rows(db, "CSRF_FAILED")) == 1  # the first; three are coalesced
    # Leaving the context runs the lifespan shutdown, which flushes the coalescer.
    rows = audit_rows(db, "CSRF_FAILED")
    assert len(rows) == 2
    assert rows[1].meta == {
        "reason": "cross_site",
        "method": "POST",
        "route": "/api/v1/auth/login",
        "deferred": True,
        "coalesced": 2,
    }
    assert str(rows[1].ip_address) == "198.51.100.40"


def test_a_shutdown_without_pending_counts_writes_nothing(app: FastAPI, connection, db: Session) -> None:
    with TestClient(app, base_url="https://testserver", client=("198.51.100.41", 1234)) as client:
        assert _cross_site_post(client) == 403
    assert len(audit_rows(db, "CSRF_FAILED")) == 1


def test_scoped_ipv6_peer_is_recorded_without_an_address(make_client, world: World, db: Session) -> None:
    api = Api(make_client(client=("fe80::1%eth0", 50000)))
    failed = api.login(world.a.employee.email, "Wrong-Password-123")
    assert failed.status_code == 401
    [row] = audit_rows(db, "AUTH_LOGIN_FAILED", entity_id=world.a.employee.id)
    assert row.ip_address is None and row.meta == {"reason": "bad_password"}
    # A correct login works too (it used to fail inserting the session's inet value).
    succeeded = api.login(world.a.employee.email, DEFAULT_PASSWORD)
    assert succeeded.status_code == 200, error_code(succeeded)
    assert audit_rows(db, "AUTH_LOGIN_SUCCEEDED", entity_id=world.a.employee.id)[-1].ip_address is None


def test_security_event_survives_a_value_postgresql_rejects(connection, db: Session, world: World) -> None:
    # Whatever slips past address parsing must not cost the audit row: it is written without the
    # request's network details instead.
    context = RequestContext(ip_address="fe80::1%eth0", user_agent="Agent/1.0", request_id="req-0123456789")
    event = SecurityEvent(
        action="ACCESS_DENIED",
        company_id=world.a.company.id,
        actor_user_id=world.a.employee.id,
        metadata={"method": "GET", "route": "/api/v1/users"},
    )
    assert record_security_event(event, context) is True
    [row] = audit_rows(db, "ACCESS_DENIED")
    assert row.ip_address is None and row.user_agent is None
    assert row.request_id == "req-0123456789"
    assert row.actor_user_id == world.a.employee.id
