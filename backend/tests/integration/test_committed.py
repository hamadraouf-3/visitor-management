"""Tests that need real commits on separate connections (contract §11)."""

import threading
import time
import uuid
from collections.abc import Iterator

import pytest
from fastapi import BackgroundTasks
from sqlalchemy import select, text
from sqlalchemy.orm import Session, sessionmaker

from app.core.errors import Forbidden, LastAdmin
from app.core.request_context import SYSTEM_CONTEXT
from app.email.dispatcher import EmailDispatcher, schedule_delivery
from app.email.providers.base import EmailDeliveryError
from app.email.providers.memory import MemoryProvider
from app.email.rendering import EmailRenderer
from app.email.service import EmailService
from app.models import Company, EmailMessage, Role, User
from app.schemas.users import UserUpdate
from app.security.passwords import PasswordHasherService
from app.security.sessions import AuthContext
from tests.support import live_auth, unique, users_service

pytestmark = pytest.mark.committed


@pytest.fixture
def tenant(committed_session_factory: sessionmaker[Session], hasher: PasswordHasherService) -> Iterator[dict]:
    with committed_session_factory() as db:
        company = Company(name="Committed Co", slug=unique("committed"), timezone="Asia/Amman")
        db.add(company)
        db.flush()
        password_hash = hasher.hash("Committed-Password-1")
        admins = []
        for _ in range(2):
            user = User(
                company_id=company.id,
                full_name=unique("Admin"),
                email=f"{unique('admin')}@example.com",
                password_hash=password_hash,
                roles=[Role.SYSTEM_ADMIN.value],
            )
            db.add(user)
            admins.append(user)
        db.commit()
        yield {
            "company_id": company.id,
            "admin_ids": [user.id for user in admins],
            "emails": [u.email for u in admins],
        }


def _auth(db: Session, user_id: uuid.UUID) -> AuthContext:
    user = db.get(User, user_id)
    assert user is not None
    return live_auth(db, user, frozenset({Role.SYSTEM_ADMIN}))


# ---- e-mail dispatcher --------------------------------------------------------------------------


def _queue_reset_email(maker: sessionmaker[Session], settings, user_id: uuid.UUID, provider_name: str):
    with maker() as db:
        user = db.get(User, user_id)
        job = EmailService(
            db, settings=settings, renderer=EmailRenderer(), provider_name=provider_name
        ).queue_password_reset(user, "t" * 43)
        db.commit()
    return job


def _message(maker: sessionmaker[Session], message_id: uuid.UUID) -> EmailMessage:
    with maker() as db:
        return db.scalars(select(EmailMessage).where(EmailMessage.id == message_id)).one()


def test_dispatcher_delivers_committed_message(committed_session_factory, committed_settings, tenant) -> None:
    provider = MemoryProvider()
    job = _queue_reset_email(
        committed_session_factory, committed_settings, tenant["admin_ids"][0], provider.name
    )

    status = EmailDispatcher(provider, sleep=lambda _s: None).deliver(job)

    assert status == "SENT"
    message = _message(committed_session_factory, job.message_id)
    assert message.status == "SENT"
    assert message.attempts == 1
    assert message.provider_message_id == f"memory-{job.message_id}"
    assert message.sent_at is not None and message.last_error is None
    assert provider.sent[0].to == tenant["emails"][0]


def test_dispatcher_retries_transient_failures_with_backoff(
    committed_session_factory, committed_settings, tenant
) -> None:
    provider = MemoryProvider()
    provider.fail_next(2, transient=True)
    sleeps: list[float] = []
    job = _queue_reset_email(
        committed_session_factory, committed_settings, tenant["admin_ids"][0], provider.name
    )

    status = EmailDispatcher(provider, sleep=sleeps.append).deliver(job)

    assert status == "SENT"
    assert sleeps == [1.0, 3.0]
    assert _message(committed_session_factory, job.message_id).attempts == 3


def test_dispatcher_gives_up_after_three_transient_failures(
    committed_session_factory, committed_settings, tenant
) -> None:
    provider = MemoryProvider()
    provider.fail_next(3, transient=True)
    job = _queue_reset_email(
        committed_session_factory, committed_settings, tenant["admin_ids"][0], provider.name
    )

    status = EmailDispatcher(provider, sleep=lambda _s: None).deliver(job)

    message = _message(committed_session_factory, job.message_id)
    assert status == "FAILED"
    assert message.status == "FAILED"
    assert message.attempts == 3
    assert message.last_error == "Simulated delivery failure."
    assert message.last_attempt_at is not None and message.sent_at is None


class _SlowFailingProvider:
    """Fails transiently, each attempt taking `seconds` of the dispatcher's monotonic clock (a provider
    that answers late, or times out)."""

    name = "memory"

    def __init__(self, seconds: float) -> None:
        self.seconds = seconds
        self.now = 0.0
        self.timeouts: list[float] = []

    def monotonic(self) -> float:
        return self.now

    def send(self, email, *, timeout_seconds=None):
        self.timeouts.append(timeout_seconds)
        self.now += min(self.seconds, timeout_seconds)
        raise EmailDeliveryError("The email service did not respond in time.", transient=True)


def test_no_retry_starts_after_the_message_deadline(
    committed_session_factory, committed_settings, tenant
) -> None:
    """A provider that does not answer: the first attempt runs into the 10 s read timeout, the second is
    bounded by the 9 s left of the 20 s deadline, and no third starts (20 s instead of 49 s a message)."""
    provider = _SlowFailingProvider(seconds=10.0)
    sleeps: list[float] = []

    def sleep(seconds: float) -> None:
        sleeps.append(seconds)
        provider.now += seconds

    job = _queue_reset_email(
        committed_session_factory, committed_settings, tenant["admin_ids"][0], provider.name
    )
    dispatcher = EmailDispatcher(provider, sleep=sleep, monotonic=provider.monotonic)

    assert dispatcher.deliver(job) == "FAILED"

    assert provider.timeouts == [20.0, 9.0] and sleeps == [1.0]
    assert provider.now == 20.0
    message = _message(committed_session_factory, job.message_id)
    assert (message.status, message.attempts) == ("FAILED", 2)
    assert message.last_error == "The email service did not respond in time."


def test_permanent_failure_is_not_retried(committed_session_factory, committed_settings, tenant) -> None:
    provider = MemoryProvider(fail_domain="example.com")
    sleeps: list[float] = []
    job = _queue_reset_email(
        committed_session_factory, committed_settings, tenant["admin_ids"][0], provider.name
    )

    assert EmailDispatcher(provider, sleep=sleeps.append).deliver(job) == "FAILED"
    assert sleeps == []
    assert _message(committed_session_factory, job.message_id).attempts == 1


def test_dispatcher_ignores_messages_that_are_not_pending(
    committed_session_factory, committed_settings, tenant
) -> None:
    provider = MemoryProvider()
    job = _queue_reset_email(
        committed_session_factory, committed_settings, tenant["admin_ids"][0], provider.name
    )
    dispatcher = EmailDispatcher(provider, sleep=lambda _s: None)
    assert dispatcher.deliver(job) == "SENT"
    assert dispatcher.deliver(job) is None  # already SENT: never sent twice
    assert len(provider.sent) == 1


def test_uncommitted_message_is_not_delivered(committed_session_factory, committed_settings, tenant) -> None:
    provider = MemoryProvider()
    with committed_session_factory() as db:
        user = db.get(User, tenant["admin_ids"][0])
        job = EmailService(
            db, settings=committed_settings, renderer=EmailRenderer(), provider_name="memory"
        ).queue_password_reset(user, "t" * 43)
        # A separate connection cannot see the uncommitted row, so nothing is sent.
        assert EmailDispatcher(provider, sleep=lambda _s: None).deliver(job) is None
        with pytest.raises(RuntimeError, match="commit the transaction"):
            schedule_delivery(BackgroundTasks(), db, EmailDispatcher(provider), job)
        db.rollback()
    assert provider.sent == []


# ---- last-admin race ----------------------------------------------------------------------------


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
    raise AssertionError("the second transaction never waited for the company lock")


def test_concurrent_admin_demotions_keep_one_admin(
    committed_session_factory, committed_settings, hasher, tenant
) -> None:
    """A demotes B while B demotes A on two connections: the company row lock serialises them, so the
    second change sees the first. B is no longer an administrator then, so the re-check of B's
    authorization refuses it (SEC-07) before the LAST_ADMIN guard, which stays as the backstop."""
    admin_a, admin_b = tenant["admin_ids"]
    first = committed_session_factory()
    second = committed_session_factory()
    try:
        auth_a = _auth(first, admin_a)
        auth_b = _auth(second, admin_b)
        second.execute(text("SET lock_timeout = '10s'"))
        second_pid = second.execute(text("SELECT pg_backend_pid()")).scalar_one()

        # Transaction 1 is mid-flight and holds the company lock.
        first.execute(select(Company).where(Company.id == tenant["company_id"]).with_for_update())

        outcome: dict[str, object] = {}

        def demote_a() -> None:
            service = users_service(second, hasher, committed_settings)
            try:
                service.update_user(auth_b, admin_a, UserUpdate(roles=[Role.EMPLOYEE]), SYSTEM_CONTEXT)
                outcome["result"] = "demoted"
            except (LastAdmin, Forbidden) as exc:
                second.rollback()
                outcome["result"] = type(exc).__name__
            except Exception as exc:  # surfaced in the assertion below
                outcome["result"] = repr(exc)

        worker = threading.Thread(target=demote_a)
        worker.start()
        _wait_for_lock_wait(committed_session_factory, second_pid)

        users_service(first, hasher, committed_settings).update_user(
            auth_a, admin_b, UserUpdate(roles=[Role.EMPLOYEE]), SYSTEM_CONTEXT
        )
        worker.join(timeout=15)
        assert not worker.is_alive()
        assert outcome["result"] == "Forbidden"
    finally:
        first.close()
        second.close()

    with committed_session_factory() as db:
        users = db.scalars(select(User).where(User.company_id == tenant["company_id"])).all()
        admins = [user.id for user in users if Role.SYSTEM_ADMIN.value in user.roles and user.is_active]
        assert admins == [admin_a]
