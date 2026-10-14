"""Engine, the single session factory, and the request-scoped `get_db` dependency (contract §3.2-1/2).

Every component (requests, the email dispatcher, the security-event writer, the CLI) gets its sessions
from `session_factory`. Tests replace only that object's target via `override()`.
"""

from collections.abc import Iterator, Mapping
from dataclasses import dataclass
from typing import Any

from sqlalchemy import Engine, create_engine
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import Settings

# Session settings the application depends on, pinned by every connection it opens (the libpq startup
# `options`), whatever the server, database or role defaults are: startup options take precedence over
# all of them (SEC-37, SEC-38). The runtime role can give itself lasting defaults (`ALTER ROLE … SET`,
# which PostgreSQL lets every role do and nobody can revoke), so a leaked runtime credential could
# otherwise make every write fail (`default_transaction_read_only`), or silently turn the re-checks that
# rely on READ COMMITTED (`services.authorization`, the last-administrator guard, the migrations'
# downgrade guards) into reads of a snapshot taken before the lock they waited for
# (`default_transaction_isolation`). The others keep what the driver parses and the queries mean fixed.
# The application's engine also pins its statement and lock timeouts (`DatabaseTimeouts`); other
# operational settings (`synchronous_commit`, …) are left to the database's own configuration;
# production refuses to start while the runtime role has defaults of its own (`db.privileges`).
SESSION_SETTINGS: dict[str, str] = {
    "timezone": "UTC",
    "client_encoding": "UTF8",
    "DateStyle": "ISO",
    "IntervalStyle": "postgres",
    "bytea_output": "hex",
    "search_path": "public",
    "transform_null_equals": "off",
    "default_transaction_isolation": "read committed",
    "default_transaction_read_only": "off",
}

# TCP keepalives on every connection of the application's engine (libpq parameters): an idle pooled
# connection whose peer vanished (a failover, a dropped NAT entry) is found dead after about a minute
# instead of when the operating system gives up (hours), and `tcp_user_timeout` (Linux) bounds how long
# sent data may stay unacknowledged, so a query on a half-open connection fails instead of hanging.
KEEPALIVE_PARAMETERS: dict[str, int] = {
    "keepalives": 1,
    "keepalives_idle": 30,
    "keepalives_interval": 10,
    "keepalives_count": 3,
}


@dataclass(frozen=True, slots=True)
class DatabaseTimeouts:
    """How long the application waits for the database.

    * `connect_seconds`: libpq `connect_timeout` for a new connection (TCP, TLS and authentication; libpq
      applies it to each address a host name resolves to). psycopg's own default is 130 s.
    * `pool_seconds`: SQLAlchemy `pool_timeout`, the wait for a free pooled connection (default 30 s).
    * `statement_ms` / `lock_ms`: PostgreSQL `statement_timeout` / `lock_timeout` (startup options), so a
      statement or a lock wait that never ends is cancelled (SQLSTATE 57014 / 55P03: 503 SERVICE_BUSY).
    """

    connect_seconds: int = 5
    pool_seconds: int = 5
    statement_ms: int = 30_000
    lock_ms: int = 10_000

    @classmethod
    def from_settings(cls, settings: Settings) -> DatabaseTimeouts:
        return cls(
            connect_seconds=settings.db_connect_timeout_seconds,
            pool_seconds=settings.db_pool_timeout_seconds,
            statement_ms=settings.db_statement_timeout_ms,
            lock_ms=settings.db_lock_timeout_ms,
        )

    def session_settings(self) -> dict[str, str]:
        return {"statement_timeout": str(self.statement_ms), "lock_timeout": str(self.lock_ms)}

    def connect_parameters(self) -> dict[str, int]:
        # `tcp_user_timeout` (milliseconds): data sent to a peer that has gone, keepalive probes
        # included, is given up after 30 s. A long query on a live server leaves nothing unacknowledged:
        # the statement timeout bounds that instead.
        return {"connect_timeout": self.connect_seconds, **KEEPALIVE_PARAMETERS, "tcp_user_timeout": 30_000}


def connection_options(extra: Mapping[str, str] | None = None) -> str:
    """The libpq `options` value that pins `SESSION_SETTINGS` (and `extra`), spaces escaped as libpq
    requires."""
    settings = {**SESSION_SETTINGS, **(extra or {})}
    return " ".join(f"-c {name}={value.replace(' ', '\\ ')}" for name, value in settings.items())


def create_db_engine(
    url: str,
    *,
    pool_size: int = 10,
    application_name: str = "vms-api",
    timeouts: DatabaseTimeouts | None = None,
) -> Engine:
    """An engine whose connections pin `SESSION_SETTINGS`. With `timeouts` (the application's engine),
    also its connect, pool, statement and lock timeouts and TCP keepalives; libpq parameters already
    given in the URL's query string are left as the URL says."""
    connect_args: dict[str, Any] = {"application_name": application_name}
    options: dict[str, Any] = {}
    if timeouts is not None:
        given = make_url(url).query
        connect_args |= {
            name: value for name, value in timeouts.connect_parameters().items() if name not in given
        }
        options["pool_timeout"] = timeouts.pool_seconds
    connect_args["options"] = connection_options(
        timeouts.session_settings() if timeouts is not None else None
    )
    return create_engine(
        url,
        pool_pre_ping=True,
        pool_size=pool_size,
        max_overflow=pool_size,
        # Parameters can contain personal data; keep them out of exception messages and logs.
        hide_parameters=True,
        connect_args=connect_args,
        **options,
    )


def create_app_engine(settings: Settings) -> Engine:
    return create_db_engine(
        settings.runtime_url,
        pool_size=settings.db_pool_size,
        timeouts=DatabaseTimeouts.from_settings(settings),
    )


def make_sessionmaker(engine: Engine) -> sessionmaker[Session]:
    # expire_on_commit=False: services commit and then build responses from the same objects.
    return sessionmaker(bind=engine, expire_on_commit=False, autoflush=True)


class SessionFactory:
    """Callable returning new `Session`s; the target can be configured once and overridden in tests."""

    def __init__(self) -> None:
        self._default: sessionmaker[Session] | None = None
        self._override: sessionmaker[Session] | None = None

    def configure(self, engine: Engine) -> None:
        self._default = make_sessionmaker(engine)

    @property
    def is_configured(self) -> bool:
        return self._default is not None or self._override is not None

    def override(self, maker: sessionmaker[Session]) -> None:
        self._override = maker

    def clear_override(self) -> None:
        self._override = None

    def __call__(self) -> Session:
        maker = self._override or self._default
        if maker is None:
            raise RuntimeError("the database session factory is not configured")
        return maker()


session_factory = SessionFactory()


def get_db() -> Iterator[Session]:
    """Request-scoped session. Never commits: services commit explicitly.

    Declared with `Depends(get_db, scope="function")` (see `app.api.deps.DbSession`) so this cleanup
    runs before the response is sent and therefore before any background task.
    """
    db = session_factory()
    try:
        yield db
    finally:
        if db.in_transaction():
            db.rollback()
        db.close()
