"""E-mails whose delivery was lost (readiness round 1): a PENDING row nobody is delivering any more is
marked FAILED (Needs attention, INVITATION_FAILED), at startup and by the periodic sweep, and a resend
closes the invitation it replaces."""

from datetime import timedelta
from uuid import UUID

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.core.time import FakeClock
from app.email.dispatcher import INTERRUPTED_AFTER, INTERRUPTED_ERROR, EmailDispatcher, fail_interrupted
from app.email.providers.base import OutgoingEmail, ProviderResult
from app.email.providers.memory import MemoryProvider
from app.email.service import DeliveryJob
from app.main import create_app
from app.models import EmailKind, EmailMessage
from tests.conftest import TEST_START
from tests.support import TEST_CLIENT_ADDRESS, Api, World, audit_rows, create_visit, signed_in

START = TEST_START + timedelta(hours=2)  # 11:00 in Asia/Amman: the visits stay SCHEDULED throughout


@pytest.fixture
def host(make_client, world: World) -> Api:
    return signed_in(make_client, world.a.employee)


def _invitation(db: Session, visit_id: str) -> EmailMessage:
    db.expire_all()
    return db.scalars(
        select(EmailMessage)
        .where(
            EmailMessage.visit_id == UUID(visit_id),
            EmailMessage.kind == EmailKind.VISITOR_INVITATION.value,
        )
        .order_by(EmailMessage.created_at.desc())
    ).first()  # type: ignore[return-value]


def _left_pending(db: Session, message: EmailMessage) -> None:
    """The row as a process killed during the first attempt leaves it: PENDING, no attempt recorded."""
    db.execute(
        update(EmailMessage)
        .where(EmailMessage.id == message.id)
        .values(
            status="PENDING",
            attempts=0,
            sent_at=None,
            provider_message_id=None,
            last_error=None,
            last_attempt_at=None,
            updated_at=message.created_at,
        )
    )
    db.flush()


def _job(message: EmailMessage) -> DeliveryJob:
    return DeliveryJob(
        message_id=message.id,
        email=OutgoingEmail(
            message_id=message.id,
            kind=EmailKind(message.kind),
            to=message.to_email,
            subject=message.subject,
            html="<p>x</p>",
            text="x",
        ),
    )


def test_an_interrupted_invitation_is_failed_and_needs_attention(
    host: Api, world: World, db: Session, clock: FakeClock
) -> None:
    visit = create_visit(host, world.a.employee.id, START, send_invitation=True)["visit"]
    message = _invitation(db, visit["id"])
    _left_pending(db, message)
    assert host.get("/visits", params={"needs_attention": "true"}).json()["total"] == 0  # as shipped

    clock.advance(INTERRUPTED_AFTER - timedelta(seconds=1))
    assert fail_interrupted() == []  # a delivery could still be under way
    assert _invitation(db, visit["id"]).status == "PENDING"

    clock.advance(timedelta(seconds=2))
    closed = fail_interrupted()

    assert [row.id for row in closed] == [message.id]
    failed = _invitation(db, visit["id"])
    assert (failed.status, failed.last_error, failed.attempts) == ("FAILED", INTERRUPTED_ERROR, 0)
    detail = host.get(f"/visits/{visit['id']}").json()
    assert detail["invitation"]["status"] == "FAILED"
    assert detail["invitation"]["error"] == INTERRUPTED_ERROR
    attention = host.get("/visits", params={"needs_attention": "true"}).json()
    assert [item["id"] for item in attention["items"]] == [visit["id"]]
    assert host.get("/dashboard/employee").json()["counts"]["needs_attention"] == 1
    rows = audit_rows(db, "INVITATION_FAILED", entity_id=UUID(visit["id"]))
    assert len(rows) == 1
    assert rows[0].actor_user_id is None and rows[0].company_id == world.a.company.id
    assert rows[0].meta == {
        "email_message_id": str(message.id),
        "recipient_domain": "example.com",
        "attempts": 0,
        "reason": "interrupted",
    }
    assert fail_interrupted() == []  # once only


def test_every_kind_of_lost_message_is_failed_but_only_invitations_are_audited(
    host: Api, world: World, db: Session, clock: FakeClock
) -> None:
    visit = create_visit(host, world.a.employee.id, START, send_invitation=True)["visit"]
    invitation = _invitation(db, visit["id"])
    _left_pending(db, invitation)
    db.execute(
        update(EmailMessage)
        .where(EmailMessage.id == invitation.id)
        .values(kind=EmailKind.VISIT_RESCHEDULED.value)
    )
    clock.advance(INTERRUPTED_AFTER + timedelta(seconds=1))

    assert [row.kind for row in fail_interrupted()] == ["VISIT_RESCHEDULED"]
    db.expire_all()
    assert db.get(EmailMessage, invitation.id).status == "FAILED"  # type: ignore[union-attr]
    assert audit_rows(db, "INVITATION_FAILED") == []


def test_a_closed_message_is_never_sent_afterwards(
    host: Api, world: World, db: Session, clock: FakeClock
) -> None:
    visit = create_visit(host, world.a.employee.id, START, send_invitation=True)["visit"]
    message = _invitation(db, visit["id"])
    _left_pending(db, message)
    clock.advance(INTERRUPTED_AFTER + timedelta(seconds=1))
    fail_interrupted()
    provider = MemoryProvider()

    # A job still queued behind the delivery slots when its row was closed.
    assert EmailDispatcher(provider, sleep=lambda _s: None).deliver(_job(message)) is None
    assert provider.attempts == 0


class _SlowProvider:
    """Takes `minutes` of fake time to answer, and lets the sweep run meanwhile."""

    name = "memory"

    def __init__(self, clock: FakeClock, minutes: float) -> None:
        self.clock = clock
        self.minutes = minutes
        self.closed_during_send: list[UUID] = []

    def send(self, email: OutgoingEmail, *, timeout_seconds: float | None = None) -> ProviderResult:
        self.clock.advance(timedelta(minutes=self.minutes))
        self.closed_during_send += [row.id for row in fail_interrupted()]
        return ProviderResult(provider_message_id="slow")


def test_a_delivery_under_way_is_left_alone(host: Api, world: World, db: Session, clock: FakeClock) -> None:
    """The delivery claims the row (its `updated_at`) when it starts: a message that waited for a slot
    longer than the threshold but is being sent now is not failed under it."""
    visit = create_visit(host, world.a.employee.id, START, send_invitation=True)["visit"]
    message = _invitation(db, visit["id"])
    _left_pending(db, message)
    clock.advance(INTERRUPTED_AFTER - timedelta(minutes=1))  # waited 4 minutes for a slot
    provider = _SlowProvider(clock, minutes=2)  # 6 minutes after queueing, 2 after the claim

    assert EmailDispatcher(provider, sleep=lambda _s: None).deliver(_job(message)) == "SENT"
    assert provider.closed_during_send == []
    assert _invitation(db, visit["id"]).status == "SENT"


def test_startup_fails_the_deliveries_a_previous_process_lost(
    settings, app_engine, hasher, world: World, db: Session, clock: FakeClock, make_client
) -> None:
    host = signed_in(make_client, world.a.employee)
    visit = create_visit(host, world.a.employee.id, START, send_invitation=True)["visit"]
    message = _invitation(db, visit["id"])
    _left_pending(db, message)
    clock.advance(INTERRUPTED_AFTER + timedelta(seconds=1))
    restarted = create_app(
        settings, engine=app_engine, password_hasher=hasher, email_provider=MemoryProvider()
    )

    with TestClient(restarted, base_url="https://testserver", client=TEST_CLIENT_ADDRESS):
        pass  # the lifespan's first sweep runs before the application serves

    assert _invitation(db, visit["id"]).status == "FAILED"
    assert len(audit_rows(db, "INVITATION_FAILED", entity_id=UUID(visit["id"]))) == 1


def test_a_resend_closes_the_invitation_it_replaces(
    host: Api, world: World, db: Session, email_provider: MemoryProvider
) -> None:
    visit = create_visit(host, world.a.employee.id, START, send_invitation=True)["visit"]
    first = _invitation(db, visit["id"])
    _left_pending(db, first)  # still queued, or lost

    response = host.post(f"/visits/{visit['id']}/invitation")

    assert response.status_code == 200, response.text
    assert _invitation(db, visit["id"]).status == "SENT"  # the new one
    replaced = db.get(EmailMessage, first.id)
    assert replaced is not None
    assert (replaced.status, replaced.last_error) == ("FAILED", "Replaced by a newer invitation.")
    rows = audit_rows(db, "INVITATION_FAILED", entity_id=UUID(visit["id"]))
    assert [row.meta["reason"] for row in rows] == ["superseded"]
    assert rows[0].meta["email_message_id"] == str(first.id)
    assert rows[0].request_id == response.headers["X-Request-ID"] and rows[0].actor_user_id is None
    # The replaced job, if it was still waiting for a slot, sends nothing (its pass was rotated).
    assert EmailDispatcher(email_provider, sleep=lambda _s: None).deliver(_job(first)) is None
