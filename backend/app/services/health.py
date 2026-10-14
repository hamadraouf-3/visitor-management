"""GET /health's database check (`DatabaseProbe`).

The check must answer within the container health check's 5 s even when the database does not: it does
not use the application's pool (whose connections and request threads a hung database holds, and whose
waits are bounded at 5 s each), but a connection of its own per check with a 2 s connect timeout and a
2 s statement timeout, in a worker thread outside the request threads' limiter, and the request stops
waiting after `ANSWER_WITHIN_SECONDS` whatever the thread is doing (the thread is left to finish). A
result is reused for `CACHE_SECONDS`, so however often the endpoint is called (it needs no session),
the database sees at most one connection a second from it.
"""

import logging
import threading
import time
from collections.abc import Callable

import anyio
import anyio.to_thread
from anyio import CapacityLimiter
from anyio.lowlevel import RunVar
from sqlalchemy import Engine, create_engine, text
from sqlalchemy.pool import NullPool

from app.db.session import connection_options

logger = logging.getLogger("app.health")

CONNECT_TIMEOUT_SECONDS = 2  # libpq's minimum
STATEMENT_TIMEOUT_MS = 2_000
ANSWER_WITHIN_SECONDS = 3.0
CACHE_SECONDS = 1.0
_PROBE_THREADS = 2  # threads a hung check can hold; further checks time out waiting for one


class DatabaseProbe:
    def __init__(
        self,
        url: str,
        *,
        answer_within_seconds: float = ANSWER_WITHIN_SECONDS,
        cache_seconds: float = CACHE_SECONDS,
        monotonic: Callable[[], float] = time.monotonic,
    ) -> None:
        self._url = url
        self._answer_within = answer_within_seconds
        self._cache_seconds = cache_seconds
        self._monotonic = monotonic
        self._engine: Engine | None = None
        self._lock = threading.Lock()  # one check at a time; the others reuse its result
        self._last: tuple[float, bool] | None = None
        self._threads: RunVar[CapacityLimiter] = RunVar(f"health-probe-threads-{id(self)}")

    def _connect_engine(self) -> Engine:
        if self._engine is None:
            self._engine = create_engine(
                self._url,
                poolclass=NullPool,  # a new connection per check: never a half-open pooled one
                hide_parameters=True,
                connect_args={
                    "connect_timeout": CONNECT_TIMEOUT_SECONDS,
                    "options": connection_options({"statement_timeout": str(STATEMENT_TIMEOUT_MS)}),
                    "application_name": "vms-api-health",
                },
            )
        return self._engine

    def check(self) -> bool:
        """Whether the database answers `SELECT 1` (blocking; at most one query per `cache_seconds`)."""
        with self._lock:
            if self._last is not None and self._monotonic() - self._last[0] < self._cache_seconds:
                return self._last[1]
            try:
                with self._connect_engine().connect() as connection:
                    connection.execute(text("SELECT 1"))
                available = True
            except Exception as exc:
                logger.warning("database health check failed: %s", type(exc).__name__)
                available = False
            self._last = (self._monotonic(), available)
            return available

    async def is_available(self) -> bool:
        """`check()` in a worker thread of the probe's own, answered within `answer_within_seconds`."""
        try:
            threads = self._threads.get()
        except LookupError:
            threads = CapacityLimiter(_PROBE_THREADS)
            self._threads.set(threads)
        with anyio.move_on_after(self._answer_within):
            return await anyio.to_thread.run_sync(self.check, limiter=threads, abandon_on_cancel=True)
        logger.warning("database health check timed out")
        return False

    def dispose(self) -> None:
        if self._engine is not None:
            self._engine.dispose()
