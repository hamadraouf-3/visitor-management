"""The audit trail under abuse and as an API resource (contract §7.4, §8.1 `AuditLog`)."""

from ipaddress import IPv4Address

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.request_context import RequestContext
from app.core.time import FakeClock
from app.models import AuditLog as AuditLogRow
from app.schemas.audit import AuditLog
from app.schemas.common import UserRef
from app.services import audit
from app.services.audit import ANONYMOUS_ROWS_PER_WINDOW, AuditAction, AuditEntity
from tests.support import Api, World, audit_rows, error_code

# ---- unbounded denials are coalesced ------------------------------------------------------------


def test_throttled_logins_write_one_row_per_window(
    client: TestClient, world: World, db: Session, clock: FakeClock
) -> None:
    api = Api(client)
    for _ in range(5):
        api.login(world.a.employee.email, "Wrong-Password-123")
    for _ in range(50):
        response = api.login(world.a.employee.email, "Wrong-Password-123")
        assert response.status_code == 429 and error_code(response) == "RATE_LIMITED"

    rows = audit_rows(db, "RATE_LIMITED")
    assert len(rows) == 1  # every response is still a 429; only the audit write is coalesced
    assert rows[0].meta == {
        "policy": "login_failures_ip_email",
        "method": "POST",
        "route": "/api/v1/auth/login",
    }

    clock.advance(seconds=60)
    api.login(world.a.employee.email, "Wrong-Password-123")
    rows = audit_rows(db, "RATE_LIMITED")
    assert len(rows) == 2
    assert rows[-1].meta["coalesced"] == 49  # the repeats of the previous window are accounted for


def test_cross_origin_flood_writes_one_row_per_window(client: TestClient, db: Session) -> None:
    for _ in range(60):
        response = client.post(
            "/api/v1/auth/forgot-password",
            json={"email": "someone@example.com"},
            headers={"Origin": "https://evil.example"},
        )
        assert response.status_code == 403
    rows = audit_rows(db, "CSRF_FAILED")
    assert len(rows) == 1
    assert rows[0].meta == {
        "reason": "origin_not_allowed",
        "method": "POST",
        "route": "/api/v1/auth/forgot-password",
    }


def test_dropped_forgot_password_requests_are_coalesced(
    client: TestClient, world: World, db: Session
) -> None:
    api = Api(client)
    for _ in range(40):
        response = api.post("/auth/forgot-password", json={"email": world.a.employee.email}, csrf=False)
        assert response.status_code == 202
    # Requests 4-10 pass the client's budget and are dropped by the account's (in the background); the
    # rest are dropped by the client's. One row each; the repeats are coalesced.
    assert [row.meta for row in audit_rows(db, "RATE_LIMITED")] == [
        {"policy": "forgot_password_account"},
        {"policy": "forgot_password_ip"},
    ]


def test_denials_by_different_clients_are_not_merged(make_client, world: World, db: Session) -> None:
    for address in ("198.51.100.1", "198.51.100.2"):
        api = Api(make_client(client=(address, 1000)))
        for _ in range(7):
            api.login(world.a.employee.email, "Wrong-Password-123")
    assert sorted(str(row.ip_address) for row in audit_rows(db, "RATE_LIMITED")) == [
        "198.51.100.1",
        "198.51.100.2",
    ]


def _cross_origin_post(make_client, address: str) -> int:
    client = make_client(client=(address, 1234))
    return client.post(
        "/api/v1/departments", json={"name": "Spam"}, headers={"Origin": "https://evil.example"}
    ).status_code


CROSS_ORIGIN_DEPARTMENTS = {"reason": "origin_not_allowed", "method": "POST", "route": "/api/v1/departments"}


def test_cross_origin_flood_rotating_64s_of_one_48_writes_one_row(
    make_client, app: FastAPI, db: Session
) -> None:
    statuses = [_cross_origin_post(make_client, f"2001:db8:77:{index + 1:x}::1") for index in range(200)]
    assert statuses == [403] * 200
    assert [row.meta for row in audit_rows(db, "CSRF_FAILED")] == [CROSS_ORIGIN_DEPARTMENTS]

    app.state.security_audit.flush()  # what a sweep does a window later, or the shutdown
    rows = audit_rows(db, "CSRF_FAILED")
    assert len(rows) == 2
    assert rows[1].meta == {**CROSS_ORIGIN_DEPARTMENTS, "deferred": True, "coalesced": 198}


def test_cross_origin_flood_from_many_addresses_stays_within_the_budget(
    make_client, app: FastAPI, db: Session
) -> None:
    statuses = [
        _cross_origin_post(make_client, f"198.18.{index // 200}.{index % 200 + 1}") for index in range(60)
    ]
    assert statuses == [403] * 60
    assert len(audit_rows(db, "CSRF_FAILED")) == ANONYMOUS_ROWS_PER_WINDOW

    app.state.security_audit.flush()
    rows = audit_rows(db, "CSRF_FAILED")
    assert len(rows) == ANONYMOUS_ROWS_PER_WINDOW + 1
    assert rows[-1].meta == {
        **CROSS_ORIGIN_DEPARTMENTS,
        "deferred": True,
        "overflow": True,
        "coalesced": 60 - ANONYMOUS_ROWS_PER_WINDOW - 1,
    }


# ---- AuditLog response built from a stored row -------------------------------------------------


def test_audit_log_schema_is_built_from_a_stored_row(world: World, db: Session) -> None:
    context = RequestContext(ip_address="203.0.113.10", user_agent="pytest", request_id="req-0000000001")
    audit.record(
        db,
        action=AuditAction.USER_UPDATED,
        context=context,
        company_id=world.a.company.id,
        actor_user_id=world.a.admin.id,
        entity_type=AuditEntity.USER,
        entity_id=world.a.employee.id,
        metadata={"changed_fields": ["phone"]},
    )
    db.commit()
    db.expire_all()
    row = db.scalars(select(AuditLogRow).where(AuditLogRow.request_id == "req-0000000001")).one()
    assert isinstance(row.ip_address, IPv4Address)

    actor = UserRef(id=world.a.admin.id, full_name=world.a.admin.full_name)
    payload = AuditLog.from_row(row, actor=actor).model_dump(mode="json")

    assert payload == {
        "id": str(row.id),
        "seq": row.seq,
        "created_at": payload["created_at"],
        "action": "USER_UPDATED",
        "actor": {"id": str(world.a.admin.id), "full_name": world.a.admin.full_name},
        "entity_type": "user",
        "entity_id": str(world.a.employee.id),
        "metadata": {"changed_fields": ["phone"]},
        "ip_address": "203.0.113.10",
        "user_agent": "pytest",
        "request_id": "req-0000000001",
    }
    assert payload["created_at"].endswith("Z")
    assert AuditLog.from_row(row, actor=None).actor is None
