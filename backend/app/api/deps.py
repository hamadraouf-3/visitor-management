"""FastAPI dependencies: database session, authentication, authorization and services.

* `DbSession` declares `get_db` with `scope="function"`: its cleanup (rollback/close) runs when the
  endpoint returns, i.e. before the response is sent and before background tasks (contract §3.2-1).
* `SessionAuth` authenticates the session cookie (no password-change gate); it is used only by
  GET /auth/me, POST /auth/change-password, POST /auth/logout and PATCH /auth/preferences (the language
  can be switched on the forced-change screen, B10-3).
* `CurrentAuth` adds the PASSWORD_CHANGE_REQUIRED gate.
* `PlatformSessionAuth` / `PlatformAuth` are the same pair for the platform owner (B11-6): the platform
  session cookie, its own per-administrator API budget key, and the gate. They accept no tenant session,
  and no tenant dependency accepts a platform session.
* Authorization is by capability, never by listing roles in a route: `require_capability(...)` checks
  the §7.5 matrix in `app.security.permissions` (the single source of truth, unit-tested), so routes
  and services cannot drift from it. Row-level rules (visit ownership, visitor scope) stay in services.
* Query parameters are one `QueryModel` per endpoint (`query: Annotated[Model, Query()]`, see
  `app.schemas.common`); dependencies run first, so unauthorized callers get 401/403 before any 422.
"""

import json
from collections.abc import Callable
from typing import Annotated

import anyio
from fastapi import Depends, Request
from pydantic import ValidationError
from sqlalchemy.orm import Session
from starlette.requests import ClientDisconnect

from app.core import time as app_time
from app.core.config import Settings
from app.core.errors import (
    INVALID_JSON_MESSAGE,
    BadRequest,
    Forbidden,
    NotAuthenticated,
    NotFound,
    PasswordChangeRequired,
    RateLimited,
    RequestTimeout,
    UnsupportedMediaType,
    ValidationFailed,
    validation_problems,
)
from app.core.field_errors import FieldCode, FieldProblem
from app.core.request_context import RequestContext
from app.db.session import get_db
from app.email.dispatcher import EmailDispatcher
from app.schemas.tracking import TrackingEventBatch
from app.security.passwords import PasswordHasherService
from app.security.permissions import Capability, has_capability, parse_roles
from app.security.platform_sessions import (
    PlatformAuthContext,
    PlatformSessionManager,
    platform_cookie_names,
)
from app.security.sessions import (
    BACKGROUND_REFRESH_HEADER,
    AuthContext,
    SessionManager,
    SessionPolicy,
    cookie_names,
)
from app.services.attendance import AttendanceService
from app.services.audit_trail import AuditTrailService
from app.services.auth import AuthService, PasswordResetIssuer
from app.services.brand import BrandReader, PlatformBrandService, PublicBrandService
from app.services.company import CompanyService
from app.services.dashboard import DashboardService
from app.services.departments import DepartmentsService
from app.services.email_templates import EmailTemplatesService
from app.services.environment import ServiceEnvironment
from app.services.journeys import JourneyService
from app.services.locations import LocationsService
from app.services.platform_auth import PlatformAuthService
from app.services.platform_companies import PlatformCompaniesService
from app.services.preferences import PreferencesService
from app.services.reception import ReceptionService
from app.services.reports import ReportsService
from app.services.scan import ReceptionScanService
from app.services.tracking_ingestion import TrackingIngestion, TrackingKeyContext, authenticate_key, limit_key
from app.services.tracking_settings import TrackingSettingsService
from app.services.users import HostedVisitCanceller, UsersService
from app.services.visit_snapshots import VisitSnapshotRefresher
from app.services.visitors import VisitorsService
from app.services.visits import VisitsService

DbSession = Annotated[Session, Depends(get_db, scope="function")]


# ---- application state --------------------------------------------------------------------------


def get_app_settings(request: Request) -> Settings:
    settings: Settings = request.app.state.settings
    return settings


def get_request_context(request: Request) -> RequestContext:
    return RequestContext.from_request(request)


def get_service_environment(request: Request) -> ServiceEnvironment:
    """The application's one `ServiceEnvironment` (built by `create_app`)."""
    environment: ServiceEnvironment = request.app.state.service_environment
    return environment


SettingsDep = Annotated[Settings, Depends(get_app_settings)]
ContextDep = Annotated[RequestContext, Depends(get_request_context)]
ServiceEnvironmentDep = Annotated[ServiceEnvironment, Depends(get_service_environment)]


# ---- authentication -----------------------------------------------------------------------------


def is_background_refresh(request: Request) -> bool:
    """Whether the client marked the request as a background refresh (`X-Background-Refresh: 1`: polling,
    the session heartbeat, a refetch nobody asked for). Such a request is served like any other but does
    not count as activity: it never extends a session's idle window, the company's or the platform's."""
    return request.headers.get(BACKGROUND_REFRESH_HEADER) == "1"


def get_session_auth(
    request: Request, db: DbSession, settings: SettingsDep, env: ServiceEnvironmentDep
) -> AuthContext:
    policy: SessionPolicy = request.app.state.session_policy
    manager = SessionManager(db, policy)
    now = app_time.now()
    found = manager.lookup(request.cookies.get(cookie_names(settings.cookie_secure).session), now=now)
    if found is None:
        raise NotAuthenticated()
    session, user = found
    auth = AuthContext.build(user, session, parse_roles(user.roles))
    request.state.auth = auth  # lets error handlers attribute denials to this user

    api_policy = env.policies.api_per_user
    decision = env.limiter.hit(api_policy, str(user.id))
    if not decision.allowed:
        raise RateLimited(retry_after=decision.retry_after, policy=api_policy.name)

    if manager.touch(session, now=now, background=is_background_refresh(request)):
        db.commit()
    return auth


SessionAuth = Annotated[AuthContext, Depends(get_session_auth)]


def get_current_auth(auth: SessionAuth) -> AuthContext:
    if auth.user.must_change_password:
        raise PasswordChangeRequired()
    return auth


CurrentAuth = Annotated[AuthContext, Depends(get_current_auth)]


def require_capability(capability: Capability) -> Callable[[AuthContext], AuthContext]:
    """Dependency granting access when any of the caller's roles grants `capability` (§7.5);
    403 FORBIDDEN (audited as ACCESS_DENIED) otherwise."""

    def dependency(auth: CurrentAuth) -> AuthContext:
        if not has_capability(auth.roles, capability):
            raise Forbidden()
        return auth

    dependency.__name__ = f"require_{capability.value}"
    return dependency


AdminAuth = Annotated[AuthContext, Depends(require_capability(Capability.ADMINISTER))]
ReadVisitsAuth = Annotated[AuthContext, Depends(require_capability(Capability.READ_VISITS))]
CreateVisitAuth = Annotated[AuthContext, Depends(require_capability(Capability.CREATE_VISIT))]
ManageVisitsAuth = Annotated[AuthContext, Depends(require_capability(Capability.MANAGE_OWN_VISITS))]
ReadVisitorsAuth = Annotated[AuthContext, Depends(require_capability(Capability.READ_VISITORS))]
CreateVisitorAuth = Annotated[AuthContext, Depends(require_capability(Capability.CREATE_VISITOR))]
EditVisitorAuth = Annotated[AuthContext, Depends(require_capability(Capability.EDIT_VISITOR))]
ReceptionAuth = Annotated[AuthContext, Depends(require_capability(Capability.RECEPTION))]
ViewInsideAuth = Annotated[AuthContext, Depends(require_capability(Capability.VIEW_INSIDE))]
EmployeeDashboardAuth = Annotated[AuthContext, Depends(require_capability(Capability.EMPLOYEE_DASHBOARD))]
AdminDashboardAuth = Annotated[AuthContext, Depends(require_capability(Capability.ADMIN_DASHBOARD))]
ReportsAuth = Annotated[AuthContext, Depends(require_capability(Capability.VIEW_REPORTS))]
AuditAuth = Annotated[AuthContext, Depends(require_capability(Capability.READ_AUDIT))]
# The Visitor Journey (Phase 15, B15-13).
ViewJourneysAuth = Annotated[AuthContext, Depends(require_capability(Capability.VIEW_JOURNEYS))]
TrackVisitsAuth = Annotated[AuthContext, Depends(require_capability(Capability.TRACK_VISITS))]


# ---- the platform owner (B11-6) -----------------------------------------------------------------


def get_platform_session_auth(
    request: Request, db: DbSession, settings: SettingsDep, env: ServiceEnvironmentDep
) -> PlatformAuthContext:
    """The platform session cookie's live session (no password-change gate). A tenant session never
    authenticates here, nor a platform session on a tenant route."""
    policy: SessionPolicy = request.app.state.platform_session_policy
    manager = PlatformSessionManager(db, policy)
    now = app_time.now()
    found = manager.lookup(
        request.cookies.get(platform_cookie_names(settings.cookie_secure).session), now=now
    )
    if found is None:
        raise NotAuthenticated()
    session, admin = found
    auth = PlatformAuthContext.build(admin, session)
    request.state.auth = auth  # lets error handlers attribute denials to this administrator
    api_policy = env.policies.api_per_user
    decision = env.limiter.hit(api_policy, f"platform:{admin.id}")
    if not decision.allowed:
        raise RateLimited(retry_after=decision.retry_after, policy=api_policy.name)
    # The platform pages' heartbeat and refetches are background refreshes like the company pages'
    # (B11-34): they never extend the idle window, or an open tab would never time out.
    if manager.touch(session, now=now, background=is_background_refresh(request)):
        db.commit()
    return auth


PlatformSessionAuth = Annotated[PlatformAuthContext, Depends(get_platform_session_auth)]


def get_current_platform_auth(auth: PlatformSessionAuth) -> PlatformAuthContext:
    if auth.admin.must_change_password:
        raise PasswordChangeRequired()
    return auth


PlatformAuth = Annotated[PlatformAuthContext, Depends(get_current_platform_auth)]

PNG_MEDIA_TYPE = "image/png"
NOT_A_PNG_UPLOAD = "Upload the image as a PNG file (Content-Type: image/png)."
# How long the whole body of an upload may take to arrive (B12-18). nginx passes this one body on while
# it arrives (deploy/nginx: `proxy_request_buffering off` for the upload), so that a request nobody is
# signed in for ends at the API's 401 instead of holding a place while its body trickles in. The API
# therefore meets a slow body itself, and nginx's own timeout is between two reads, not for the whole
# body. 512 KiB in 30 seconds is 17 KiB a second: slower than any connection an upload page is used on.
PNG_UPLOAD_SECONDS = 30.0
UPLOAD_TOO_SLOW = "The upload did not arrive in time. Please try again."
UPLOAD_INTERRUPTED = "The upload was interrupted. Please try again."


async def read_png_upload(request: Request, auth: PlatformAuth) -> bytes:
    """The raw body of a brand image upload (B12-6): `Content-Type: image/png`, anything else 415.

    It depends on `PlatformAuth`, so nothing of the body is read for a caller who is not the signed-in
    platform owner (401, 403 first). The body's size is bounded by `BodySizeLimitMiddleware`, which
    answers 413 from the declared length before the request reaches this, or while this reads a body
    that declared none. The time it may take is bounded here: a body that is not complete after
    PNG_UPLOAD_SECONDS answers 408 (B12-18), and one whose sender went away answers 400 to nobody, as
    FastAPI answers a JSON body that ends early, instead of an unhandled error in the log. What the
    bytes are is decided by the service (`app.core.png`), never by this header."""
    media_type = request.headers.get("content-type", "").partition(";")[0].strip().lower()
    if media_type != PNG_MEDIA_TYPE:
        raise UnsupportedMediaType(NOT_A_PNG_UPLOAD)
    timed_out = False
    try:
        with anyio.fail_after(PNG_UPLOAD_SECONDS):
            return await request.body()
    except TimeoutError:
        timed_out = True
    except ClientDisconnect:
        pass
    # Raised outside the handlers, so the answer does not keep the frames that held the part of the
    # body that had arrived (see `services.brand.checked_image`).
    if timed_out:
        raise RequestTimeout(UPLOAD_TOO_SLOW)
    raise BadRequest(UPLOAD_INTERRUPTED)


PngUpload = Annotated[bytes, Depends(read_png_upload)]


# ---- the tracking provider's ingestion (Phase 15, B15-17) -----------------------------------------

JSON_MEDIA_TYPE = "application/json"
NOT_JSON = "Send the events as JSON (Content-Type: application/json)."
INVALID_JSON = FieldProblem(FieldCode.INVALID_JSON, INVALID_JSON_MESSAGE)


def get_tracking_key(
    request: Request, db: DbSession, settings: SettingsDep, env: ServiceEnvironmentDep
) -> TrackingKeyContext:
    """The provider's key (`Authorization: Bearer <key>`), never a cookie. With the provider `disabled`
    the route behaves as absent: 404 before anything else (B15-1)."""
    if not env.tracking.enabled:
        raise NotFound()
    key = authenticate_key(
        db,
        request.headers.get("authorization"),
        client_ip=request.scope.get("state", {}).get("client_ip"),
        secret_key=settings.secret_key.get_secret_value(),
        limiter=env.limiter,
        policies=env.policies,
    )
    request.state.auth = key  # the access log and a RATE_LIMITED row name the company
    limit_key(key, limiter=env.limiter, policies=env.policies)
    return key


TrackingKeyAuth = Annotated[TrackingKeyContext, Depends(get_tracking_key)]


async def read_tracking_batch(request: Request, key: TrackingKeyAuth) -> TrackingEventBatch:
    """The batch, read only once the key is accepted (401, 404 and 429 come first, so nothing of the
    body of a stranger is parsed). Its size is bounded by `BodySizeLimitMiddleware` (64 KiB); a body that
    is not JSON or not a valid batch answers 422 with the paths of its problems."""
    media_type = request.headers.get("content-type", "").partition(";")[0].strip().lower()
    if media_type != JSON_MEDIA_TYPE:
        raise UnsupportedMediaType(NOT_JSON)
    try:
        payload = json.loads(await request.body())
    except ClientDisconnect:
        raise BadRequest(UPLOAD_INTERRUPTED) from None
    except ValueError, RecursionError:  # not JSON, not UTF-8, or nested past the parser's depth
        raise ValidationFailed({"body": INVALID_JSON}) from None
    try:
        return TrackingEventBatch.model_validate(payload)
    except ValidationError as exc:
        raise ValidationFailed(validation_problems(exc.errors(), payload)) from None


TrackingBatch = Annotated[TrackingEventBatch, Depends(read_tracking_batch)]


# ---- services -----------------------------------------------------------------------------------


def get_auth_service(
    request: Request, db: DbSession, settings: SettingsDep, env: ServiceEnvironmentDep
) -> AuthService:
    return AuthService(
        db,
        settings=settings,
        hasher=request.app.state.password_hasher,
        limiter=env.limiter,
        policies=env.policies,
        session_policy=request.app.state.session_policy,
        security_audit=request.app.state.security_audit,
        emails=env.email_service(db),
        device_trust=request.app.state.device_trust,
    )


def get_password_reset_issuer(
    request: Request, settings: SettingsDep, env: ServiceEnvironmentDep
) -> PasswordResetIssuer:
    dispatcher: EmailDispatcher = request.app.state.email_dispatcher
    return PasswordResetIssuer(
        settings=settings,
        renderer=env.renderer,
        dispatcher=dispatcher,
        limiter=env.limiter,
        policies=env.policies,
        security_audit=request.app.state.security_audit,
    )


def get_users_service(request: Request, db: DbSession, env: ServiceEnvironmentDep) -> UsersService:
    hasher: PasswordHasherService = request.app.state.password_hasher
    hosted_visits: HostedVisitCanceller = request.app.state.hosted_visit_canceller
    snapshots: VisitSnapshotRefresher = request.app.state.visit_snapshot_refresher
    return UsersService(
        db,
        hasher=hasher,
        hosted_visits=hosted_visits,
        snapshots=snapshots,
        limiter=env.limiter,
        policies=env.policies,
    )


def get_departments_service(request: Request, db: DbSession) -> DepartmentsService:
    snapshots: VisitSnapshotRefresher = request.app.state.visit_snapshot_refresher
    return DepartmentsService(db, snapshots=snapshots)


def get_company_service(db: DbSession) -> CompanyService:
    return CompanyService(db)


def get_preferences_service(db: DbSession) -> PreferencesService:
    return PreferencesService(db)


def get_email_dispatcher(request: Request) -> EmailDispatcher:
    dispatcher: EmailDispatcher = request.app.state.email_dispatcher
    return dispatcher


def get_visits_service(db: DbSession, env: ServiceEnvironmentDep) -> VisitsService:
    return VisitsService(db, env)


def get_visitors_service(db: DbSession, env: ServiceEnvironmentDep) -> VisitorsService:
    return VisitorsService(db, env)


def get_scan_service(db: DbSession, env: ServiceEnvironmentDep) -> ReceptionScanService:
    return ReceptionScanService(db, env)


def get_attendance_service(db: DbSession, env: ServiceEnvironmentDep) -> AttendanceService:
    return AttendanceService(db, env)


def get_reception_service(db: DbSession) -> ReceptionService:
    return ReceptionService(db)


def get_dashboard_service(db: DbSession) -> DashboardService:
    return DashboardService(db)


def get_reports_service(db: DbSession) -> ReportsService:
    return ReportsService(db)


def get_audit_trail_service(db: DbSession) -> AuditTrailService:
    return AuditTrailService(db)


def get_platform_auth_service(
    request: Request, db: DbSession, settings: SettingsDep, env: ServiceEnvironmentDep
) -> PlatformAuthService:
    return PlatformAuthService(
        db,
        settings=settings,
        hasher=request.app.state.password_hasher,
        limiter=env.limiter,
        policies=env.policies,
        session_policy=request.app.state.platform_session_policy,
        security_audit=request.app.state.security_audit,
        device_trust=request.app.state.device_trust,
    )


def get_platform_companies_service(
    request: Request, db: DbSession, settings: SettingsDep, env: ServiceEnvironmentDep
) -> PlatformCompaniesService:
    return PlatformCompaniesService(
        db,
        settings=settings,
        hasher=request.app.state.password_hasher,
        limiter=env.limiter,
        policies=env.policies,
        emails=env.email_service(db),
        brands=BrandReader(db),
        tracking=env.tracking,
    )


def get_email_templates_service(
    db: DbSession, settings: SettingsDep, env: ServiceEnvironmentDep
) -> EmailTemplatesService:
    return EmailTemplatesService(
        db, settings=settings, emails=env.email_service(db), limiter=env.limiter, policies=env.policies
    )


def get_brand_reader(db: DbSession) -> BrandReader:
    return BrandReader(db)


def get_platform_brand_service(db: DbSession, env: ServiceEnvironmentDep) -> PlatformBrandService:
    return PlatformBrandService(db, limiter=env.limiter, policies=env.policies, logo_warm_up=env.logo_warm_up)


def get_public_brand_service(
    db: DbSession, settings: SettingsDep, env: ServiceEnvironmentDep
) -> PublicBrandService:
    """The service of the public identity endpoints (B12-9). It takes no session: nothing here reads a
    cookie."""
    return PublicBrandService(db, settings=settings, limiter=env.limiter, policies=env.policies)


def get_journey_service(db: DbSession, env: ServiceEnvironmentDep) -> JourneyService:
    return JourneyService(db, env.tracking)


def get_locations_service(db: DbSession) -> LocationsService:
    return LocationsService(db)


def get_tracking_settings_service(db: DbSession, env: ServiceEnvironmentDep) -> TrackingSettingsService:
    return TrackingSettingsService(db, env.tracking)


def get_tracking_ingestion(db: DbSession, env: ServiceEnvironmentDep) -> TrackingIngestion:
    return TrackingIngestion(db, env.tracking)


AuthServiceDep = Annotated[AuthService, Depends(get_auth_service)]
PasswordResetIssuerDep = Annotated[PasswordResetIssuer, Depends(get_password_reset_issuer)]
UsersServiceDep = Annotated[UsersService, Depends(get_users_service)]
DepartmentsServiceDep = Annotated[DepartmentsService, Depends(get_departments_service)]
CompanyServiceDep = Annotated[CompanyService, Depends(get_company_service)]
PreferencesServiceDep = Annotated[PreferencesService, Depends(get_preferences_service)]
EmailDispatcherDep = Annotated[EmailDispatcher, Depends(get_email_dispatcher)]
VisitsServiceDep = Annotated[VisitsService, Depends(get_visits_service)]
VisitorsServiceDep = Annotated[VisitorsService, Depends(get_visitors_service)]
ScanServiceDep = Annotated[ReceptionScanService, Depends(get_scan_service)]
AttendanceServiceDep = Annotated[AttendanceService, Depends(get_attendance_service)]
ReceptionServiceDep = Annotated[ReceptionService, Depends(get_reception_service)]
DashboardServiceDep = Annotated[DashboardService, Depends(get_dashboard_service)]
ReportsServiceDep = Annotated[ReportsService, Depends(get_reports_service)]
AuditTrailServiceDep = Annotated[AuditTrailService, Depends(get_audit_trail_service)]
PlatformAuthServiceDep = Annotated[PlatformAuthService, Depends(get_platform_auth_service)]
PlatformCompaniesServiceDep = Annotated[PlatformCompaniesService, Depends(get_platform_companies_service)]
EmailTemplatesServiceDep = Annotated[EmailTemplatesService, Depends(get_email_templates_service)]
BrandReaderDep = Annotated[BrandReader, Depends(get_brand_reader)]
PlatformBrandServiceDep = Annotated[PlatformBrandService, Depends(get_platform_brand_service)]
PublicBrandServiceDep = Annotated[PublicBrandService, Depends(get_public_brand_service)]
JourneyServiceDep = Annotated[JourneyService, Depends(get_journey_service)]
LocationsServiceDep = Annotated[LocationsService, Depends(get_locations_service)]
TrackingSettingsServiceDep = Annotated[TrackingSettingsService, Depends(get_tracking_settings_service)]
TrackingIngestionDep = Annotated[TrackingIngestion, Depends(get_tracking_ingestion)]
