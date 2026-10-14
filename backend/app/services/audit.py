"""Audit writing (contract §7.4).

* `record(db, …)` adds a row inside the caller's business transaction (successful events).
* `record_security_event(…)` writes failures/denials through its own session from `session_factory`
  and commits immediately, so the failing request's rollback cannot erase it. It never raises.
* `SecurityAudit` is the request-facing writer for failures/denials: it attributes events to the
  authenticated user and coalesces the denials a client can trigger without bound (see
  `SecurityEventCoalescer`).

Metadata holds IDs, enums, counts and changed-field names only (§3.2-8). `sanitize_metadata` enforces
the shape: strings must look like identifiers (letters, digits and `_ . : / { } -`), so e-mail
addresses, names with spaces, phone numbers and free text are rejected.
"""

import logging
import re
import threading
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field, replace
from datetime import datetime
from enum import Enum, StrEnum
from typing import Any
from uuid import UUID

from sqlalchemy.exc import DataError
from sqlalchemy.orm import Session
from starlette.requests import Request

from app.core import time as app_time
from app.core.client_ip import rate_limit_prefix, rate_limit_subject
from app.core.errors import SecurityEvent
from app.core.middleware import CsrfFailureReason, CsrfSessionInfo
from app.core.request_context import RequestContext
from app.core.routing import is_platform_path, route_path, route_template
from app.db.session import session_factory
from app.models import AuditLog, PlatformAuditLog
from app.repositories.audit_logs import AuditLogRepository

logger = logging.getLogger("app.audit")

_MAX_KEY_LENGTH = 64
_MAX_LIST_LENGTH = 50
_IDENTIFIER = re.compile(r"[A-Za-z0-9_.:/{}-]{1,100}")


class AuditAction(StrEnum):
    # authentication
    AUTH_LOGIN_SUCCEEDED = "AUTH_LOGIN_SUCCEEDED"
    AUTH_LOGIN_FAILED = "AUTH_LOGIN_FAILED"
    AUTH_ACCOUNT_THROTTLED = "AUTH_ACCOUNT_THROTTLED"
    AUTH_LOGOUT = "AUTH_LOGOUT"
    AUTH_PASSWORD_CHANGED = "AUTH_PASSWORD_CHANGED"
    AUTH_PASSWORD_CHANGE_FAILED = "AUTH_PASSWORD_CHANGE_FAILED"
    AUTH_PASSWORD_RESET_REQUESTED = "AUTH_PASSWORD_RESET_REQUESTED"
    AUTH_PASSWORD_RESET_COMPLETED = "AUTH_PASSWORD_RESET_COMPLETED"
    AUTH_PASSWORD_RESET_FAILED = "AUTH_PASSWORD_RESET_FAILED"
    # security denials
    ACCESS_DENIED = "ACCESS_DENIED"
    CSRF_FAILED = "CSRF_FAILED"
    RATE_LIMITED = "RATE_LIMITED"
    # administration
    USER_CREATED = "USER_CREATED"
    USER_UPDATED = "USER_UPDATED"
    USER_ROLES_CHANGED = "USER_ROLES_CHANGED"
    USER_DEACTIVATED = "USER_DEACTIVATED"
    USER_REACTIVATED = "USER_REACTIVATED"
    USER_CHANGE_REFUSED = "USER_CHANGE_REFUSED"
    DEPARTMENT_CREATED = "DEPARTMENT_CREATED"
    DEPARTMENT_UPDATED = "DEPARTMENT_UPDATED"
    COMPANY_CREATED = "COMPANY_CREATED"
    COMPANY_SETTINGS_UPDATED = "COMPANY_SETTINGS_UPDATED"
    COMPANY_DEACTIVATED = "COMPANY_DEACTIVATED"  # by the platform owner (B11-10)
    COMPANY_REACTIVATED = "COMPANY_REACTIVATED"
    # A company's logo, icon or colour set or removed by the platform owner (B12-7): `changed_fields`
    # names which (logo, logo_dark, icon, color), `removed_fields` those of them that were removed.
    COMPANY_BRAND_UPDATED = "COMPANY_BRAND_UPDATED"
    # the platform owner's accounts (CLI and seeds, B11-3)
    PLATFORM_ADMIN_CREATED = "PLATFORM_ADMIN_CREATED"
    PLATFORM_ADMIN_PASSWORD_SET = "PLATFORM_ADMIN_PASSWORD_SET"
    # a company's own e-mail texts (B11-30)
    EMAIL_TEMPLATE_UPDATED = "EMAIL_TEMPLATE_UPDATED"
    EMAIL_TEMPLATE_RESET = "EMAIL_TEMPLATE_RESET"
    EMAIL_TEMPLATE_TEST_SENT = "EMAIL_TEMPLATE_TEST_SENT"
    # visitors
    VISITOR_CREATED = "VISITOR_CREATED"
    VISITOR_UPDATED = "VISITOR_UPDATED"
    VISITOR_LINK_REFUSED = "VISITOR_LINK_REFUSED"  # inline details named another person (B57-01)
    # visits
    VISIT_CREATED = "VISIT_CREATED"
    VISIT_UPDATED = "VISIT_UPDATED"
    VISIT_RESCHEDULED = "VISIT_RESCHEDULED"
    VISIT_CANCELLED = "VISIT_CANCELLED"
    VISIT_MARKED_NO_SHOW = "VISIT_MARKED_NO_SHOW"
    VISIT_TIME_SHIFTED = "VISIT_TIME_SHIFTED"  # non-production E2E time travel only
    # reception
    VISIT_CHECKED_IN = "VISIT_CHECKED_IN"
    VISIT_CHECK_IN_REFUSED = "VISIT_CHECK_IN_REFUSED"
    VISIT_CHECKED_OUT = "VISIT_CHECKED_OUT"
    VISIT_CHECK_OUT_REFUSED = "VISIT_CHECK_OUT_REFUSED"
    STALE_VISITS_CHECKED_OUT = "STALE_VISITS_CHECKED_OUT"
    WALK_IN_CREATED = "WALK_IN_CREATED"
    WALK_IN_REFUSED = "WALK_IN_REFUSED"
    # passes and invitations
    PASS_ISSUED = "PASS_ISSUED"
    PASS_REVOKED = "PASS_REVOKED"
    PASS_SCANNED = "PASS_SCANNED"
    INVITATION_QUEUED = "INVITATION_QUEUED"
    INVITATION_SENT = "INVITATION_SENT"
    INVITATION_FAILED = "INVITATION_FAILED"


class AuditEntity(StrEnum):
    COMPANY = "company"
    DEPARTMENT = "department"
    USER = "user"
    SESSION = "session"
    VISITOR = "visitor"
    VISIT = "visit"
    PASS = "pass"
    EMAIL = "email"
    PLATFORM_ADMIN = "platform_admin"  # B11-4
    EMAIL_TEMPLATE = "email_template"  # B11-30: `metadata.kind` names it


def _sanitize_value(value: Any, key: str) -> Any:
    if value is None or isinstance(value, bool | int | float):
        return value
    if isinstance(value, Enum):
        value = value.value
        if not isinstance(value, str):
            return _sanitize_value(value, key)
    if isinstance(value, UUID):
        return str(value)
    if isinstance(value, str):
        if not _IDENTIFIER.fullmatch(value):
            raise ValueError(f"audit metadata {key!r}: strings are limited to identifiers and enums")
        return value
    if isinstance(value, list | tuple | set | frozenset):
        items = sorted(value, key=str) if isinstance(value, set | frozenset) else list(value)
        if len(items) > _MAX_LIST_LENGTH:
            raise ValueError(f"audit metadata {key!r}: too many items")
        return [_sanitize_value(item, key) for item in items]
    raise ValueError(f"audit metadata {key!r}: unsupported type {type(value).__name__}")


def sanitize_metadata(metadata: Mapping[str, Any] | None) -> dict[str, Any]:
    clean: dict[str, Any] = {}
    for key, value in (metadata or {}).items():
        if not key or len(key) > _MAX_KEY_LENGTH:
            raise ValueError("audit metadata keys must be short strings")
        clean[key] = _sanitize_value(value, key)
    return clean


def _build_entry(
    *,
    action: str,
    context: RequestContext,
    company_id: UUID | None,
    actor_user_id: UUID | None,
    entity_type: str | None,
    entity_id: UUID | None,
    metadata: Mapping[str, Any] | None,
) -> AuditLog:
    return AuditLog(
        company_id=company_id,
        actor_user_id=actor_user_id,
        action=str(action),
        entity_type=str(entity_type) if entity_type is not None else None,
        entity_id=entity_id,
        meta=sanitize_metadata(metadata),
        ip_address=context.ip_address,
        user_agent=context.user_agent,
        request_id=context.request_id,
    )


def record(
    db: Session,
    *,
    action: AuditAction | str,
    context: RequestContext,
    company_id: UUID | None,
    actor_user_id: UUID | None,
    entity_type: AuditEntity | str | None = None,
    entity_id: UUID | None = None,
    metadata: Mapping[str, Any] | None = None,
) -> AuditLog:
    """Add an audit row to the caller's transaction (committed or rolled back with it)."""
    entry = _build_entry(
        action=action,
        context=context,
        company_id=company_id,
        actor_user_id=actor_user_id,
        entity_type=entity_type,
        entity_id=entity_id,
        metadata=metadata,
    )
    return AuditLogRepository(db).add(entry)


def _build_platform_entry(
    *,
    action: str,
    context: RequestContext,
    actor_platform_admin_id: UUID | None,
    company_id: UUID | None,
    entity_type: str | None,
    entity_id: UUID | None,
    metadata: Mapping[str, Any] | None,
) -> PlatformAuditLog:
    return PlatformAuditLog(
        actor_platform_admin_id=actor_platform_admin_id,
        company_id=company_id,
        action=str(action),
        entity_type=str(entity_type) if entity_type is not None else None,
        entity_id=entity_id,
        meta=sanitize_metadata(metadata),
        ip_address=context.ip_address,
        user_agent=context.user_agent,
        request_id=context.request_id,
    )


def record_platform(
    db: Session,
    *,
    action: AuditAction | str,
    context: RequestContext,
    actor_platform_admin_id: UUID | None,
    company_id: UUID | None = None,
    entity_type: AuditEntity | str | None = None,
    entity_id: UUID | None = None,
    metadata: Mapping[str, Any] | None = None,
) -> PlatformAuditLog:
    """Add a row to the platform's trail (`platform_audit_logs`, B11-4) in the caller's transaction.
    `company_id` names the company the action was about. The metadata rules of `record` apply."""
    entry = _build_platform_entry(
        action=action,
        context=context,
        actor_platform_admin_id=actor_platform_admin_id,
        company_id=company_id,
        entity_type=entity_type,
        entity_id=entity_id,
        metadata=metadata,
    )
    db.add(entry)
    return entry


def platform_source(platform_admin_id: UUID) -> dict[str, Any]:
    """The metadata a company's audit row carries when the platform owner made the change (B11-5): the row
    has no actor (no user of the company did it), and these keys say who did."""
    return {"source": "platform", "platform_admin_id": platform_admin_id}


def without_network_details(context: RequestContext) -> RequestContext:
    """`context` for a row that somebody else than the actor's own side reads: the request ID stays (the
    rows of one request share it), the actor's network address and browser do not (B11-37)."""
    return replace(context, ip_address=None, user_agent=None)


def record_platform_change(
    db: Session,
    *,
    action: AuditAction | str,
    context: RequestContext,
    platform_admin_id: UUID,
    company_id: UUID,
    entity_type: AuditEntity | str,
    entity_id: UUID | None,
    metadata: Mapping[str, Any] | None = None,
) -> None:
    """Both rows of a platform action that changes a company (B11-5), in the caller's transaction:

    * in the company's trail, without an actor (no user of the company did it), with `platform_source`
      and **without the platform owner's network address and browser** (B11-37): the company's
      administrators read this row, and where the platform owner works from is not theirs to know;
    * in the platform's trail, with the platform administrator as the actor and the request's full
      context.
    """
    record(
        db,
        action=action,
        context=without_network_details(context),
        company_id=company_id,
        actor_user_id=None,
        entity_type=entity_type,
        entity_id=entity_id,
        metadata={**(metadata or {}), **platform_source(platform_admin_id)},
    )
    record_platform(
        db,
        action=action,
        context=context,
        actor_platform_admin_id=platform_admin_id,
        company_id=company_id,
        entity_type=entity_type,
        entity_id=entity_id,
        metadata=metadata,
    )


def _write_security_event(event: SecurityEvent, context: RequestContext) -> None:
    entry: AuditLog | PlatformAuditLog
    if event.platform:
        entry = _build_platform_entry(
            action=event.action,
            context=context,
            actor_platform_admin_id=event.actor_user_id,
            company_id=event.company_id,
            entity_type=event.entity_type,
            entity_id=event.entity_id,
            metadata=event.metadata,
        )
    else:
        entry = _build_entry(
            action=event.action,
            context=context,
            company_id=event.company_id,
            actor_user_id=event.actor_user_id,
            entity_type=event.entity_type,
            entity_id=event.entity_id,
            metadata=event.metadata,
        )
    with session_factory() as db:
        db.add(entry)
        db.commit()


def record_security_event(event: SecurityEvent, context: RequestContext) -> bool:
    """Persist a failure/denial independently of the request transaction. Returns False on failure.

    The request's network details come from outside; if PostgreSQL rejects one of them (a data
    exception, e.g. an address `inet` cannot hold), the event is written once more without them rather
    than lost (§7.4: every denial is audited).
    """
    try:
        _write_security_event(event, context)
    except DataError:
        if context.ip_address is None and context.user_agent is None:
            logger.exception("could not write security audit event", extra={"action": event.action})
            return False
        try:
            _write_security_event(event, without_network_details(context))
        except Exception:
            logger.exception("could not write security audit event", extra={"action": event.action})
            return False
        logger.warning(
            "security audit event written without the request's network details",
            extra={"action": event.action},
        )
    except Exception:
        # Auditing must never turn a denial into a 500; the failure itself is logged for operators.
        logger.exception("could not write security audit event", extra={"action": event.action})
        return False
    return True


# ---- coalescing of unbounded denials ------------------------------------------------------------

COALESCED_ACTIONS = frozenset({AuditAction.RATE_LIMITED, AuditAction.CSRF_FAILED})
COALESCE_WINDOW_SECONDS = 60
# Rows written per (action, kind) and window for unattributed events, whatever their sources.
ANONYMOUS_ROWS_PER_WINDOW = 10
# Refusals any signed-in user can provoke at the API rate (600 a minute) without another bound: rows
# written per (action, user) and window (SEC-15, the attributed counterpart of the anonymous budget).
BUDGETED_ATTRIBUTED_ACTIONS = frozenset(
    {AuditAction.ACCESS_DENIED, AuditAction.VISITOR_LINK_REFUSED, AuditAction.USER_CHANGE_REFUSED}
)
ATTRIBUTED_ROWS_PER_WINDOW = 10

type PendingEvent = tuple[SecurityEvent, RequestContext]
type WindowKey = tuple[str, str, str]  # (action, source, kind)
type BudgetKey = tuple[str, str]  # (action, kind)


@dataclass(slots=True)
class _Window:
    """Events held back since `started_at`: their number and the most recent one, which becomes the
    summary row if no later written row carries the count."""

    started_at: float
    suppressed: int = 0
    last_event: SecurityEvent | None = None
    last_context: RequestContext | None = None

    def expired(self, now: float, length: int) -> bool:
        return now - self.started_at >= length

    def hold(self, event: SecurityEvent, context: RequestContext) -> None:
        self.suppressed += 1
        self.last_event, self.last_context = event, context

    def summary(self, **marks: bool) -> PendingEvent | None:
        if not self.suppressed or self.last_event is None or self.last_context is None:
            return None
        metadata: dict[str, Any] = {**self.last_event.metadata, "deferred": True, **marks}
        if self.suppressed > 1:
            metadata["coalesced"] = self.suppressed - 1  # the row itself is one of the suppressed events
        return replace(self.last_event, metadata=metadata), self.last_context


@dataclass(slots=True)
class _RowBudget:
    """Rows written in the current window for one budget (unattributed events of one (action, kind),
    whatever their sources; or one user's events of one action), and the events beyond it
    (`overflow`)."""

    started_at: float
    written: int = 0
    overflow: _Window = field(init=False)

    def __post_init__(self) -> None:
        self.overflow = _Window(started_at=self.started_at)


class SecurityEventCoalescer:
    """Bounds audit writes for denials a client can trigger without limit.

    A RATE_LIMITED or CSRF_FAILED response answers a request that is already beyond every other bound,
    so one row per response would let a client grow the append-only `audit_logs` table (and use a
    database connection plus a commit per request) at line rate. Per (action, source, policy/reason)
    the first event of each window is written; repeats inside the window are counted and the count is
    written on the next row for that key as `metadata.coalesced`.

    The source is the attributed user. An unattributed event's source is the client's site: its IPv6
    /48 (one site can rotate through 65,536 /64s) or its IPv4 address. Unattributed events also share a
    budget per (action, policy/reason) and window: at most `anonymous_rows_per_window` rows, whatever
    their sources (many addresses, many sites); the events beyond it are counted into one summary row
    (`overflow: true`). Attributed sources are bounded by the accounts that exist.

    Attributed refusals that any signed-in user can provoke without another bound (ACCESS_DENIED,
    VISITOR_LINK_REFUSED, USER_CHANGE_REFUSED; `BUDGETED_ATTRIBUTED_ACTIONS`) are not coalesced, each is
    a distinct decision worth its row, but have a budget of written rows per (action, user) and window
    (`attributed_rows_per_window`); the rest of that window becomes one summary row (`overflow: true`).
    Without it, one account could append about 600 rows a minute to the append-only table (SEC-15).

    A window whose repeats no later event picked up becomes a summary row (its last suppressed event,
    `deferred: true`, plus `coalesced` for the others) once it has expired. Expired windows are swept
    when an admission finds the last sweep a window ago, by `SecurityAudit.sweep` (the application runs
    it periodically) and, regardless of age, by `flush` at shutdown, so no count is lost on a quiet
    server or across a restart. Summary rows wait in `drain()` for the caller to write them, outside
    the lock.
    """

    def __init__(
        self,
        *,
        window_seconds: int = COALESCE_WINDOW_SECONDS,
        anonymous_rows_per_window: int = ANONYMOUS_ROWS_PER_WINDOW,
        attributed_rows_per_window: int = ATTRIBUTED_ROWS_PER_WINDOW,
        clock: Callable[[], datetime] = app_time.now,
    ) -> None:
        if anonymous_rows_per_window < 1 or attributed_rows_per_window < 1:
            raise ValueError("the rows per window must be at least 1")
        self._window = window_seconds
        self._anonymous_rows = anonymous_rows_per_window
        self._attributed_rows = attributed_rows_per_window
        self._clock = clock
        self._windows: dict[WindowKey, _Window] = {}
        self._budgets: dict[BudgetKey, _RowBudget] = {}
        self._user_budgets: dict[BudgetKey, _RowBudget] = {}
        self._pending: list[PendingEvent] = []
        self._lock = threading.Lock()
        self._last_sweep = clock().timestamp()

    @property
    def window_seconds(self) -> int:
        return self._window

    @staticmethod
    def _key(event: SecurityEvent, context: RequestContext) -> WindowKey:
        if event.actor_user_id is not None:
            source = str(event.actor_user_id)
        else:
            source = rate_limit_prefix(context.ip_address) or rate_limit_subject(context.ip_address)
        kind = event.metadata.get("policy") or event.metadata.get("reason") or ""
        # The platform's events are counted apart from the companies' (B11-4): their own windows and budgets.
        action = f"{event.action}:platform" if event.platform else str(event.action)
        return action, source, str(kind)

    def admit(self, event: SecurityEvent, context: RequestContext) -> SecurityEvent | None:
        """The event to write (carrying the count of coalesced repeats), or None to suppress it."""
        budgeted = event.action in BUDGETED_ATTRIBUTED_ACTIONS and event.actor_user_id is not None
        if not budgeted and event.action not in COALESCED_ACTIONS:
            return event
        now = self._clock().timestamp()
        with self._lock:
            if budgeted:
                admitted = self._admit_within_user_budget(event, context, now)
            else:
                admitted = self._admit(event, context, self._key(event, context), now)
            if now - self._last_sweep >= self._window:
                self._sweep(now, everything=False)
        return admitted

    def _admit_within_user_budget(
        self, event: SecurityEvent, context: RequestContext, now: float
    ) -> SecurityEvent | None:
        action = str(event.action)
        budget = self._budget(self._user_budgets, (action, str(event.actor_user_id)), now)
        if budget.written < self._attributed_rows:
            budget.written += 1
            return event
        budget.overflow.hold(event, context)
        if budget.overflow.suppressed == 1:
            logger.warning(
                "a user's refusals exceed the audit budget; the rest are counted",
                extra={"action": action, "rows_per_window": self._attributed_rows},
            )
        return None

    def _admit(
        self, event: SecurityEvent, context: RequestContext, key: WindowKey, now: float
    ) -> SecurityEvent | None:
        action, _source, kind = key
        window = self._windows.get(key)
        if window is not None and not window.expired(now, self._window):
            window.hold(event, context)
            if window.suppressed == 1:
                logger.warning(
                    "repeated security events are being coalesced",
                    extra={"action": action, "window_seconds": self._window},
                )
            return None
        if event.actor_user_id is None:
            budget = self._budget(self._budgets, (action, kind), now)
            if budget.written >= self._anonymous_rows:
                if window is not None:
                    self._emit(action, self._windows.pop(key))  # no admitted row will carry its count
                budget.overflow.hold(event, context)
                if budget.overflow.suppressed == 1:
                    logger.warning(
                        "unattributed security events exceed the audit budget; the rest are counted",
                        extra={"action": action, "rows_per_window": self._anonymous_rows},
                    )
                return None
            budget.written += 1
        carried = window.suppressed if window is not None else 0
        self._windows[key] = _Window(started_at=now)
        return replace(event, metadata={**event.metadata, "coalesced": carried}) if carried else event

    def _budget(self, budgets: dict[BudgetKey, _RowBudget], key: BudgetKey, now: float) -> _RowBudget:
        budget = budgets.get(key)
        if budget is None or budget.overflow.expired(now, self._window):
            if budget is not None:
                self._emit(key[0], budget.overflow, overflow=True)
            budget = budgets[key] = _RowBudget(started_at=now)
        return budget

    def _emit(self, action: str, window: _Window, **marks: bool) -> None:
        summary = window.summary(**marks)
        if summary is not None:
            self._pending.append(summary)
            logger.warning(
                "coalesced security events written as a deferred summary",
                extra={"action": action, "coalesced": window.suppressed},
            )

    def _sweep(self, now: float, *, everything: bool) -> None:
        self._last_sweep = now
        for key in [k for k, w in self._windows.items() if everything or w.expired(now, self._window)]:
            self._emit(key[0], self._windows.pop(key))
        for budgets in (self._budgets, self._user_budgets):
            for budget_key in [
                k for k, b in budgets.items() if everything or b.overflow.expired(now, self._window)
            ]:
                self._emit(budget_key[0], budgets.pop(budget_key).overflow, overflow=True)

    def sweep(self) -> None:
        """Turn expired windows with uncarried repeats into summary rows (see `drain`)."""
        now = self._clock().timestamp()
        with self._lock:
            self._sweep(now, everything=False)

    def flush(self) -> None:
        """Turn every window with uncarried repeats into a summary row, whatever its age (shutdown)."""
        now = self._clock().timestamp()
        with self._lock:
            self._sweep(now, everything=True)

    def drain(self) -> list[PendingEvent]:
        """Summary rows produced by sweeps so far; each is returned once."""
        with self._lock:
            pending, self._pending = self._pending, []
        return pending

    def reset(self) -> None:
        with self._lock:
            self._windows.clear()
            self._budgets.clear()
            self._user_budgets.clear()
            self._pending.clear()
            self._last_sweep = self._clock().timestamp()


class SecurityAudit:
    """Request-facing writer for failure/denial events (exception handler, CSRF middleware, services)."""

    def __init__(
        self,
        coalescer: SecurityEventCoalescer,
        *,
        writer: Callable[[SecurityEvent, RequestContext], bool] = record_security_event,
    ) -> None:
        self.coalescer = coalescer
        self._write = writer

    def record(self, event: SecurityEvent, context: RequestContext) -> bool:
        admitted = self.coalescer.admit(event, context)
        written = True if admitted is None else self._write(admitted, context)
        self._write_pending()
        return written

    def sweep(self) -> None:
        """Write the summaries of expired coalescing windows (run periodically by the application)."""
        self.coalescer.sweep()
        self._write_pending()

    def flush(self) -> None:
        """Write every pending coalesced count (application shutdown)."""
        self.coalescer.flush()
        self._write_pending()

    def _write_pending(self) -> None:
        for event, context in self.coalescer.drain():
            self._write(event, context)

    def sink(self, request: Request, event: SecurityEvent) -> None:
        """Exception-handler hook: attribute the event to the authenticated principal when there is one.
        Every event of a request under /api/v1/platform belongs to the platform's trail (B11-4)."""
        auth = getattr(request.state, "auth", None)
        if is_platform_path(route_path(request.scope)):
            event = replace(event, platform=True)
        if event.attribute_to_request_user and auth is not None:
            platform_admin_id = getattr(auth, "platform_admin_id", None)
            if event.platform:
                if platform_admin_id is not None:
                    event = replace(event, actor_user_id=event.actor_user_id or platform_admin_id)
            elif platform_admin_id is None:
                event = replace(
                    event,
                    company_id=event.company_id or auth.company_id,
                    actor_user_id=event.actor_user_id or auth.user_id,
                )
            event = replace(event, attribute_to_request_user=False)
        self.record(event, RequestContext.from_request(request))

    def csrf_failure(
        self, request: Request, reason: CsrfFailureReason, session: CsrfSessionInfo | None
    ) -> None:
        self.record(
            SecurityEvent(
                action=AuditAction.CSRF_FAILED,
                company_id=session.company_id if session else None,
                actor_user_id=session.user_id if session else None,
                metadata={"reason": reason, "method": request.method, "route": route_template(request.scope)},
                platform=is_platform_path(route_path(request.scope)),
            ),
            RequestContext.from_request(request),
        )

    def reset(self) -> None:
        self.coalescer.reset()
