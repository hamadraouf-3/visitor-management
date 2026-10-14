"""Where e-mail deliveries run (readiness round 1): never in the worker threads requests use.

Every sync route and dependency (sessions, authentication, GET /health before this round) runs in
anyio's default thread limiter. A delivery that ran there held a token for as long as the provider took
(up to 49 s against a provider that does not answer), so about 40 queued messages froze the whole API.
"""

import threading
import uuid
from collections.abc import Awaitable, Callable

import anyio
import anyio.to_thread
from fastapi import BackgroundTasks

from app.email.dispatcher import EmailDispatcher, schedule_deliveries
from app.email.providers.base import EmailDeliveryError, OutgoingEmail, ProviderResult
from app.email.providers.memory import MemoryProvider
from app.email.service import DeliveryJob
from app.models import EmailKind, EmailStatus


class _Committed:
    """A session with no transaction open (what `ensure_committed` checks)."""

    def in_transaction(self) -> bool:
        return False


def _job() -> DeliveryJob:
    message_id = uuid.uuid4()
    email = OutgoingEmail(
        message_id=message_id,
        kind=EmailKind.HOST_ARRIVAL,
        to="host@example.com",
        subject="s",
        html="h",
        text="t",
    )
    return DeliveryJob(message_id=message_id, email=email)


async def _while_every_request_thread_is_busy(run: Callable[[], Awaitable[None]]) -> None:
    """Await `run()` while every token of the default thread limiter is taken, as when every request
    thread waits for something; fail after 10 s."""
    default = anyio.to_thread.current_default_thread_limiter()
    holders = [object() for _ in range(int(default.total_tokens))]
    for holder in holders:
        await default.acquire_on_behalf_of(holder)
    try:
        with anyio.fail_after(10):
            await run()
    finally:
        for holder in holders:
            default.release_on_behalf_of(holder)


def test_scheduled_deliveries_run_while_every_request_thread_is_busy() -> None:
    dispatcher = EmailDispatcher(MemoryProvider())
    delivered: list[uuid.UUID] = []

    def deliver(job: DeliveryJob) -> EmailStatus:
        delivered.append(job.message_id)
        return EmailStatus.SENT

    dispatcher.deliver = deliver  # type: ignore[method-assign]
    jobs = [_job() for _ in range(3)]
    tasks = BackgroundTasks()
    schedule_deliveries(tasks, _Committed(), dispatcher, jobs)  # type: ignore[arg-type]

    # The response's background tasks: run in the default limiter, they would wait for a request thread
    # for ever (fail_after raises TimeoutError).
    anyio.run(_while_every_request_thread_is_busy, tasks)

    assert delivered == [job.message_id for job in jobs]


class _HangingProvider:
    """Holds every send until released, counting how many run at the same time."""

    name = "memory"

    def __init__(self) -> None:
        self.release = threading.Event()
        self.started = threading.Semaphore(0)
        self._lock = threading.Lock()
        self.running = 0
        self.most = 0

    def send(self, email: OutgoingEmail, *, timeout_seconds: float | None = None) -> ProviderResult:
        with self._lock:
            self.running += 1
            self.most = max(self.most, self.running)
        self.started.release()
        try:
            self.release.wait(10)
            raise EmailDeliveryError("The email service did not respond in time.", transient=False)
        finally:
            with self._lock:
                self.running -= 1


def test_a_hanging_provider_holds_only_the_delivery_slots() -> None:
    provider = _HangingProvider()
    dispatcher = EmailDispatcher(provider, concurrency=2)

    def deliver(job: DeliveryJob) -> EmailStatus:
        try:
            provider.send(job.email)
        except EmailDeliveryError:
            return EmailStatus.FAILED
        return EmailStatus.SENT  # pragma: no cover - the provider never answers

    dispatcher.deliver = deliver  # type: ignore[method-assign]
    request_threads_answered: list[bool] = []

    async def main() -> None:
        async with anyio.create_task_group() as tasks:
            for _ in range(5):
                tasks.start_soon(dispatcher.deliver_in_background, _job())
            for _ in range(2):  # two deliveries hang in the provider
                assert await anyio.to_thread.run_sync(provider.started.acquire, True, 5)
            await anyio.sleep(0.2)
            # The other three wait for a slot (without a thread), and a request still gets a thread.
            assert provider.running == 2
            request_threads_answered.append(await anyio.to_thread.run_sync(lambda: True))
            provider.release.set()

    anyio.run(main)

    assert request_threads_answered == [True]
    assert provider.most == 2


def test_each_dispatcher_and_event_loop_has_its_own_slots() -> None:
    first, second = EmailDispatcher(MemoryProvider(), concurrency=3), EmailDispatcher(MemoryProvider())
    seen = []

    async def slots() -> None:
        seen.append((first.delivery_slots(), second.delivery_slots(), first.delivery_slots()))

    anyio.run(slots)
    anyio.run(slots)  # the test client runs each request in an event loop of its own

    (a1, b1, a1_again), (a2, _b2, _) = seen
    assert a1 is a1_again and a1 is not b1 and a1 is not a2
    assert a1.total_tokens == 3 and b1.total_tokens == 4
