"""Application factory.

Run with `python -m app.serve` (see `app.serve`: one worker, no uvicorn proxy-header handling, access
log or `Server` header). Collaborators can be injected for tests.
"""

import logging
import time
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager

import anyio
import anyio.to_thread
from fastapi import FastAPI
from fastapi.routing import APIRoute
from sqlalchemy import Engine
from sqlalchemy.exc import OperationalError
from sqlalchemy.exc import TimeoutError as PoolTimeoutError

from app.api.routes import api_router
from app.api.routes.platform import (
    BRAND_IMAGE_UPLOAD_MAX_BYTES,
    BRAND_IMAGE_UPLOAD_METHOD,
    BRAND_IMAGE_UPLOAD_PATH,
)
from app.core.config import Settings, get_settings
from app.core.errors import register_exception_handlers
from app.core.logging import configure_logging
from app.core.middleware import (
    BodyLimit,
    BodySizeLimitMiddleware,
    CsrfOriginMiddleware,
    CsrfRealm,
    FirstWrite,
    RequestContextMiddleware,
)
from app.core.rate_limit import RateLimiter, RatePolicies, create_rate_limiter
from app.core.routing import PLATFORM_PREFIX
from app.db.privileges import require_runtime_privileges
from app.db.session import create_app_engine, session_factory
from app.email.dispatcher import EmailDispatcher, fail_interrupted
from app.email.logos import LogoWarmUp
from app.email.providers.base import EmailProvider
from app.email.providers.factory import create_email_provider, email_configuration_warnings
from app.email.rendering import EmailRenderer
from app.security.csrf import (
    CSRF_EXEMPT,
    CSRF_HEADER,
    PLATFORM_CSRF_EXEMPT,
    csrf_matches,
    make_platform_session_lookup,
    make_session_lookup,
)
from app.security.device_trust import DeviceTrust
from app.security.passwords import PasswordHasherService
from app.security.platform_sessions import platform_cookie_names, platform_session_policy
from app.security.sessions import SessionPolicy, cookie_names
from app.services.audit import SecurityAudit, SecurityEventCoalescer
from app.services.environment import ServiceEnvironment
from app.services.health import DatabaseProbe
from app.services.seed_guard import require_no_seed_accounts
from app.services.users import HostedVisitCanceller
from app.services.visit_hooks import HostedVisitCancellations, VisitSnapshots
from app.services.visit_snapshots import VisitSnapshotRefresher

API_VERSION = "1.0.0"
INTERRUPTED_DELIVERY_SWEEP_SECONDS = 60.0

logger = logging.getLogger("app.main")


async def _sweep_security_events(security_audit: SecurityAudit, interval_seconds: float) -> None:
    """Write coalesced denial counts whose window ended, even when no further request arrives."""
    while True:
        await anyio.sleep(interval_seconds)
        try:
            await anyio.to_thread.run_sync(security_audit.sweep)
        except Exception:
            # This task shares the lifespan's task group: an escaping error would stop the application.
            logger.exception("sweeping coalesced security events failed")


async def _fail_interrupted_deliveries() -> None:
    try:
        await anyio.to_thread.run_sync(fail_interrupted)
    except (OperationalError, PoolTimeoutError) as exc:
        # The database is down, unreachable or saturated, at startup or for a while: the next run tries
        # again. One line without a traceback, like every other path that meets an outage (the request
        # handlers in `core.errors`, the CSRF middleware, GET /health), so an outage does not add an
        # ERROR record with a long traceback every minute. Only the error's class is logged (its text
        # names the server and the database).
        logger.warning(
            "closing interrupted e-mail deliveries skipped: database unavailable (%s)",
            type(getattr(exc, "orig", None) or exc).__name__,
        )
    except Exception:
        # Anything else is a defect worth its traceback; the next run tries again.
        logger.exception("closing interrupted e-mail deliveries failed")


async def _sweep_interrupted_deliveries(interval_seconds: float) -> None:
    """Mark FAILED, every `interval_seconds`, the e-mails whose delivery was lost
    (`email.dispatcher.fail_interrupted`; the lifespan runs it once before serving as well)."""
    while True:
        await anyio.sleep(interval_seconds)
        await _fail_interrupted_deliveries()


def _operation_id(route: APIRoute) -> str:
    return route.name


def create_app(
    settings: Settings | None = None,
    *,
    engine: Engine | None = None,
    password_hasher: PasswordHasherService | None = None,
    rate_limiter: RateLimiter | None = None,
    email_provider: EmailProvider | None = None,
    email_sleep: Callable[[float], None] = time.sleep,
    hosted_visit_canceller: HostedVisitCanceller | None = None,
    visit_snapshot_refresher: VisitSnapshotRefresher | None = None,
    warm_email_logos: bool = False,
) -> FastAPI:
    """The application. `warm_email_logos`: draw the e-mails' logos ahead of the requests that send
    them (B13-7), in threads of their own that read the database; on in the application `app.serve`
    runs (`create_served_app`), off in one a test builds."""
    settings = settings or get_settings()
    configure_logging(settings)

    owns_engine = engine is None
    engine = engine or create_app_engine(settings)
    session_factory.configure(engine)
    security_audit = SecurityAudit(SecurityEventCoalescer())
    # GET /health checks the database this engine connects to, through connections of its own.
    database_probe = DatabaseProbe(engine.url.render_as_string(hide_password=False))

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        if settings.is_production:
            # Refuse to serve with a database role that could undo the database's guarantees (SEC-23).
            await anyio.to_thread.run_sync(require_runtime_privileges, engine)
            # ... or on a database that holds the seeds' demo accounts, whose password is published
            # (B11-36): seeded before it became production's, restored from a demo, or seeded from a
            # workstation. The seed commands' own refusal guards only the process that seeds.
            await anyio.to_thread.run_sync(require_no_seed_accounts)
        # The deliveries a previous process lost (killed, crashed, restarted) show up as FAILED.
        await _fail_interrupted_deliveries()
        async with anyio.create_task_group() as tasks:
            tasks.start_soon(_sweep_security_events, security_audit, security_audit.coalescer.window_seconds)
            tasks.start_soon(_sweep_interrupted_deliveries, INTERRUPTED_DELIVERY_SWEEP_SECONDS)
            try:
                yield
            finally:
                tasks.cancel_scope.cancel()
        # Counts still held by the coalescer would otherwise be lost with the process (B1-55).
        await anyio.to_thread.run_sync(security_audit.flush)
        database_probe.dispose()
        if owns_engine:
            engine.dispose()

    production = settings.is_production
    app = FastAPI(
        title=f"{settings.product_name_en} API",  # the product's name (B10-16)
        version=API_VERSION,
        lifespan=lifespan,
        docs_url=None if production else "/docs",
        redoc_url=None,
        openapi_url=None if production else "/openapi.json",
        generate_unique_id_function=_operation_id,
        # No 307 from `/visits/` to `/visits`: Starlette builds that Location from the request's Host
        # header and the scheme it sees (http behind a TLS proxy), and no client uses trailing slashes.
        # Such paths answer 404 NOT_FOUND / 405 in the standard envelope instead.
        redirect_slashes=False,
    )

    session_policy = SessionPolicy.from_settings(settings)
    platform_policy = platform_session_policy(settings)
    provider = email_provider or create_email_provider(settings)
    for warning in email_configuration_warnings(settings):
        logger.warning("e-mail configuration: %s", warning)
    app.state.settings = settings
    app.state.session_policy = session_policy
    app.state.platform_session_policy = platform_policy
    app.state.device_trust = DeviceTrust(settings.secret_key.get_secret_value())
    app.state.password_hasher = password_hasher or PasswordHasherService(
        max_concurrency=settings.password_hash_concurrency
    )
    app.state.email_provider = provider
    app.state.email_dispatcher = EmailDispatcher(
        provider, sleep=email_sleep, concurrency=settings.email_delivery_concurrency
    )
    app.state.database_probe = database_probe
    # The one set of shared collaborators (rate limiter and policies included): every dependency and
    # the D-18 hook read this instance.
    logo_warm_up = LogoWarmUp(session_factory) if warm_email_logos else None
    environment = ServiceEnvironment(
        settings=settings,
        renderer=EmailRenderer(),
        email_provider_name=provider.name,
        limiter=rate_limiter or create_rate_limiter(settings),
        policies=RatePolicies.from_settings(settings),
        logo_warm_up=logo_warm_up,
    )
    app.state.service_environment = environment
    # The visit service's side of the user/department hooks (D-18, D-17).
    app.state.hosted_visit_canceller = hosted_visit_canceller or HostedVisitCancellations(environment)
    app.state.visit_snapshot_refresher = visit_snapshot_refresher or VisitSnapshots()
    app.state.security_audit = security_audit
    app.state.security_event_sink = security_audit.sink

    register_exception_handlers(app)
    if logo_warm_up is not None:
        # Every company's e-mail logos drawn in the background from the process's first write (B13-7):
        # the process that takes the writes sends the e-mails (`app.email.logos.LogoWarmUp`).
        app.add_middleware(FirstWrite, callback=logo_warm_up.everything)
    # Starlette wraps middleware in reverse order of addition: RequestContextMiddleware is outermost,
    # then the body-size limit (so its 413 carries the request ID and API headers), then CSRF/Origin.
    app.add_middleware(
        CsrfOriginMiddleware,
        allowed_origins=frozenset(settings.allowed_origins),
        session_cookie_name=cookie_names(settings.cookie_secure).session,
        csrf_header=CSRF_HEADER,
        exempt=CSRF_EXEMPT,
        lookup_session=make_session_lookup(session_policy),
        csrf_matches=csrf_matches,
        record_failure=security_audit.csrf_failure,
        realms=(
            CsrfRealm(
                prefix=PLATFORM_PREFIX,
                session_cookie_name=platform_cookie_names(settings.cookie_secure).session,
                lookup_session=make_platform_session_lookup(platform_policy),
                exempt=PLATFORM_CSRF_EXEMPT,
            ),
        ),
    )
    app.add_middleware(
        BodySizeLimitMiddleware,
        max_body_bytes=settings.max_request_body_bytes,
        # A company's brand image is a PNG of at most 512 KiB (B12-6): that one upload has its own
        # limit, whatever MAX_REQUEST_BODY_BYTES is.
        route_limits=(
            BodyLimit(BRAND_IMAGE_UPLOAD_METHOD, BRAND_IMAGE_UPLOAD_PATH, BRAND_IMAGE_UPLOAD_MAX_BYTES),
        ),
    )
    app.add_middleware(RequestContextMiddleware, settings=settings)
    app.include_router(api_router)
    return app


def create_served_app() -> FastAPI:
    """The application as `python -m app.serve` runs it, in every deployment (`app.serve.APP_FACTORY`):
    `create_app` with the e-mails' logos drawn ahead (B13-7). An application a test builds draws them on
    demand, so that no thread of its own reads the database under a test."""
    return create_app(warm_email_logos=True)
