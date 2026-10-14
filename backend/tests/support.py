"""Factories and helpers shared by the tests."""

import hashlib
import secrets
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from dataclasses import dataclass, field, replace
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any
from uuid import UUID

import httpx
from alembic.config import Config
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.core import time as app_time
from app.core.config import Settings
from app.core.png import sanitize_png
from app.core.rate_limit import DisabledRateLimiter, RateLimiter, RatePolicies
from app.email.rendering import EmailRenderer
from app.models import (
    AuditLog,
    BrandAssetKind,
    Company,
    Department,
    PlatformAdmin,
    PlatformAuditLog,
    Role,
    User,
    UserSession,
    Visit,
)
from app.repositories.brand import CompanyBrandRepository
from app.security.passwords import PasswordHasherService
from app.security.platform_sessions import SECURE_PLATFORM_COOKIE_NAMES
from app.security.sessions import SECURE_COOKIE_NAMES, AuthContext
from app.services.brand import IMAGE_LIMITS, brand_version, new_image_version
from app.services.environment import ServiceEnvironment
from app.services.users import UsersService
from app.services.visit_hooks import HostedVisitCancellations, VisitSnapshots

BACKEND_DIR = Path(__file__).resolve().parents[1]
API = "/api/v1"
TEST_CLIENT_ADDRESS = ("203.0.113.10", 50000)
DEFAULT_PASSWORD = "Correct-Horse-Battery-42"
# Session.info key: the highest audit_logs.seq when the test started (see `audit_rows`).
AUDIT_SEQ_WATERMARK = "audit_seq_watermark"
PLATFORM_AUDIT_SEQ_WATERMARK = "platform_audit_seq_watermark"


@dataclass(frozen=True)
class ThrowawayDatabase:
    name: str
    owner_url: str
    app_url: str
    app_role: str


def alembic_config(database: ThrowawayDatabase, url: str | None = None) -> Config:
    """Programmatic Alembic configuration; leaves logging untouched (contract §11)."""
    config = Config(str(BACKEND_DIR / "alembic.ini"))
    config.set_main_option("script_location", str(BACKEND_DIR / "alembic"))
    config.attributes["database_url"] = url or database.owner_url
    config.attributes["app_role"] = database.app_role
    config.attributes["configure_logging"] = False
    return config


def unique(prefix: str) -> str:
    return f"{prefix}-{secrets.token_hex(4)}"


def no_brand() -> dict[str, Any]:
    """`CompanyBrand` of a company without a logo, an icon or a colour, as the API answers it."""
    return {
        "logo_url": None,
        "logo_dark_url": None,
        "icon_url": None,
        "color": None,
        "palette": None,
        "version": brand_version(None, {}),
    }


def service_environment(
    settings: Settings, *, limiter: RateLimiter | None = None, provider_name: str = "memory"
) -> ServiceEnvironment:
    """The collaborators of the visit services, for tests that call services directly."""
    return ServiceEnvironment(
        settings=settings,
        renderer=EmailRenderer(),
        email_provider_name=provider_name,
        limiter=limiter or DisabledRateLimiter(),
        policies=RatePolicies.from_settings(settings),
    )


@contextmanager
def rate_limits(app: FastAPI, **limits: int) -> Iterator[None]:
    """Run with some rate-limit policies of the application set to other limits, by policy field name
    (e.g. `scan_per_user=2`). The application's one `ServiceEnvironment` is swapped and restored."""
    environment: ServiceEnvironment = app.state.service_environment
    policies = replace(
        environment.policies,
        **{name: replace(getattr(environment.policies, name), limit=limit) for name, limit in limits.items()},
    )
    app.state.service_environment = replace(environment, policies=policies)
    try:
        yield
    finally:
        app.state.service_environment = environment


def live_auth(db: Session, user: User, roles: frozenset[Role] | None = None) -> AuthContext:
    """The context of a request authenticated now: a live session, committed on a connection of its own
    so that it holds no lock in the caller's transaction. Services re-check the session once they hold
    the company lock (SEC-07), so a placeholder session would be refused. For tests on committed
    connections (the session's bind is an engine)."""
    now = app_time.now()
    with Session(db.get_bind(), expire_on_commit=False) as own:
        session = UserSession(
            user_id=user.id,
            company_id=user.company_id,
            token_hash=secrets.token_hex(32),
            csrf_token_hash=secrets.token_hex(32),
            expires_at=now + timedelta(hours=12),
            last_seen_at=now,
            created_at=now,
        )
        own.add(session)
        own.commit()
    return AuthContext.build(user, session, roles if roles is not None else user.role_set)


def users_service(db: Session, hasher: PasswordHasherService, settings: Settings) -> UsersService:
    """`UsersService` with the production hooks (D-17, D-18), as `create_app` wires them."""
    environment = service_environment(settings)
    return UsersService(
        db,
        hasher=hasher,
        hosted_visits=HostedVisitCancellations(environment),
        snapshots=VisitSnapshots(),
        limiter=environment.limiter,
        policies=environment.policies,
    )


class Factory:
    """Creates rows inside the test transaction and commits (releases) each savepoint."""

    def __init__(self, db: Session, hasher: PasswordHasherService) -> None:
        self.db = db
        self.hasher = hasher
        self._hashes: dict[str, str] = {}

    def password_hash(self, password: str) -> str:
        if password not in self._hashes:
            self._hashes[password] = self.hasher.hash(password)
        return self._hashes[password]

    def company(self, name: str = "Acme Corp", *, timezone: str = "Asia/Amman", **values: Any) -> Company:
        # English by default, so the suite's assertions on English e-mail subjects keep their meaning; the
        # product's default (Arabic, the column's default) is covered by the language tests (B10-12).
        values.setdefault("default_language", "en")
        company = Company(name=name, slug=values.pop("slug", unique("company")), timezone=timezone, **values)
        self.db.add(company)
        self.db.commit()
        return company

    def brand(
        self,
        company: Company,
        *,
        color: str | None = None,
        images: dict[BrandAssetKind, bytes] | None = None,
    ) -> None:
        """Give `company` a brand as the platform owner's uploads store it: each image through the
        upload's own check (`sanitize_png`), the colour as it is."""
        brands = CompanyBrandRepository(self.db)
        for kind, data in (images or {}).items():
            image = sanitize_png(data, IMAGE_LIMITS[kind])
            brands.put(
                company.id,
                kind,
                content=image.data,
                width=image.width,
                height=image.height,
                sha256=hashlib.sha256(image.data).hexdigest(),
                version=new_image_version(),
                now=app_time.now(),
            )
        company.brand_color = color
        self.db.commit()

    def department(
        self,
        company: Company,
        name: str | None = None,
        *,
        is_active: bool = True,
        name_ar: str | None = None,
    ) -> Department:
        department = Department(
            company_id=company.id, name=name or unique("Department"), name_ar=name_ar, is_active=is_active
        )
        self.db.add(department)
        self.db.commit()
        return department

    def user(
        self,
        company: Company,
        *,
        roles: Sequence[Role] = (Role.EMPLOYEE,),
        email: str | None = None,
        password: str = DEFAULT_PASSWORD,
        full_name: str | None = None,
        phone: str | None = None,
        department: Department | None = None,
        is_active: bool = True,
        must_change_password: bool = False,
        password_expires_at: datetime | None = None,
        preferred_language: str | None = None,
    ) -> User:
        user = User(
            company_id=company.id,
            full_name=full_name or unique("User"),
            email=email or f"{unique('user')}@example.com",
            phone=phone,
            password_hash=self.password_hash(password),
            roles=[role.value for role in roles],
            department_id=department.id if department else None,
            is_active=is_active,
            must_change_password=must_change_password,
            password_expires_at=password_expires_at,
            preferred_language=preferred_language,
        )
        self.db.add(user)
        self.db.commit()
        return user

    def platform_admin(
        self,
        *,
        email: str | None = None,
        password: str = DEFAULT_PASSWORD,
        full_name: str = "Platform Owner",
        is_active: bool = True,
        must_change_password: bool = False,
        password_expires_at: datetime | None = None,
    ) -> PlatformAdmin:
        admin = PlatformAdmin(
            email=email or f"{unique('platform')}@example.com",
            full_name=full_name,
            password_hash=self.password_hash(password),
            is_active=is_active,
            must_change_password=must_change_password,
            password_expires_at=password_expires_at,
        )
        self.db.add(admin)
        self.db.commit()
        return admin


@dataclass
class Tenant:
    company: Company
    admin: User
    employee: User
    receptionist: User
    manager: User
    finance: Department
    legacy: Department  # inactive
    users_by_role: dict[Role, User] = field(default_factory=dict)


@dataclass
class World:
    a: Tenant
    b: Tenant


def build_tenant(factory: Factory, name: str) -> Tenant:
    company = factory.company(name)
    finance = factory.department(company, "Finance")
    legacy = factory.department(company, "Legacy", is_active=False)
    admin = factory.user(company, roles=(Role.SYSTEM_ADMIN,), full_name=f"{name} Admin", department=finance)
    employee = factory.user(
        company, roles=(Role.EMPLOYEE,), full_name=f"{name} Employee", phone="+962 79 000 0001"
    )
    receptionist = factory.user(company, roles=(Role.RECEPTIONIST,), full_name=f"{name} Reception")
    manager = factory.user(company, roles=(Role.MANAGEMENT,), full_name=f"{name} Manager")
    return Tenant(
        company=company,
        admin=admin,
        employee=employee,
        receptionist=receptionist,
        manager=manager,
        finance=finance,
        legacy=legacy,
        users_by_role={
            Role.SYSTEM_ADMIN: admin,
            Role.EMPLOYEE: employee,
            Role.RECEPTIONIST: receptionist,
            Role.MANAGEMENT: manager,
        },
    )


def build_world(factory: Factory) -> World:
    return World(a=build_tenant(factory, "Alpha"), b=build_tenant(factory, "Bravo"))


class Api:
    """TestClient wrapper that sends the CSRF header from the cookie jar on unsafe requests."""

    def __init__(self, client: TestClient) -> None:
        self.client = client

    @property
    def csrf_token(self) -> str | None:
        return self.client.cookies.get(SECURE_COOKIE_NAMES.csrf)

    @property
    def session_token(self) -> str | None:
        return self.client.cookies.get(SECURE_COOKIE_NAMES.session)

    def _headers(self, headers: dict[str, str] | None, csrf: bool) -> dict[str, str]:
        merged = dict(headers or {})
        if csrf and self.csrf_token:
            merged.setdefault("X-CSRF-Token", self.csrf_token)
        return merged

    def get(self, path: str, **kwargs: Any) -> httpx.Response:
        return self.client.get(API + path, **kwargs)

    def post(self, path: str, *, csrf: bool = True, headers: dict[str, str] | None = None, **kwargs: Any):
        return self.client.post(API + path, headers=self._headers(headers, csrf), **kwargs)

    def patch(self, path: str, *, csrf: bool = True, headers: dict[str, str] | None = None, **kwargs: Any):
        return self.client.patch(API + path, headers=self._headers(headers, csrf), **kwargs)

    def put(self, path: str, *, csrf: bool = True, headers: dict[str, str] | None = None, **kwargs: Any):
        return self.client.put(API + path, headers=self._headers(headers, csrf), **kwargs)

    def delete(self, path: str, *, csrf: bool = True, headers: dict[str, str] | None = None, **kwargs: Any):
        return self.client.delete(API + path, headers=self._headers(headers, csrf), **kwargs)

    def login(self, email: str, password: str = DEFAULT_PASSWORD) -> httpx.Response:
        return self.post("/auth/login", json={"email": email, "password": password}, csrf=False)


class PlatformApi(Api):
    """`Api` for the platform owner's realm (B11-6): its own CSRF cookie and sign-in."""

    @property
    def csrf_token(self) -> str | None:
        return self.client.cookies.get(SECURE_PLATFORM_COOKIE_NAMES.csrf)

    @property
    def session_token(self) -> str | None:
        return self.client.cookies.get(SECURE_PLATFORM_COOKIE_NAMES.session)

    def login(self, email: str, password: str = DEFAULT_PASSWORD) -> httpx.Response:
        return self.post("/platform/auth/login", json={"email": email, "password": password}, csrf=False)


def platform_signed_in(
    make_client: Any, admin: PlatformAdmin, password: str = DEFAULT_PASSWORD
) -> PlatformApi:
    """A separate client (own cookie jar) signed in to the platform as `admin`."""
    api = PlatformApi(make_client())
    response = api.login(admin.email, password)
    assert response.status_code == 200, response.text
    return api


def platform_audit_rows(db: Session, action: str, **filters: Any) -> list[PlatformAuditLog]:
    """Platform audit rows for `action` written during the current test (rolled back with it)."""
    db.expire_all()
    statement = select(PlatformAuditLog).where(
        PlatformAuditLog.action == action,
        PlatformAuditLog.seq > db.info.get(PLATFORM_AUDIT_SEQ_WATERMARK, 0),
    )
    for name, value in filters.items():
        statement = statement.where(getattr(PlatformAuditLog, name) == value)
    return list(db.scalars(statement.order_by(PlatformAuditLog.seq)))


def error_code(response: httpx.Response) -> str:
    return response.json()["error"]["code"]


def audit_rows(db: Session, action: str, **filters: Any) -> list[AuditLog]:
    """Audit rows for `action` written during the current test (newest last), read fresh.

    `audit_logs` is append-only, so rows other code commits for good (anything outside the test's
    rolled-back transaction) can never be removed; the `connection` fixture records the highest `seq`
    at the start of the test and only later rows count.
    """
    db.expire_all()
    statement = select(AuditLog).where(
        AuditLog.action == action, AuditLog.seq > db.info.get(AUDIT_SEQ_WATERMARK, 0)
    )
    for name, value in filters.items():
        statement = statement.where(getattr(AuditLog, name) == value)
    return list(db.scalars(statement.order_by(AuditLog.seq)))


def refreshed[T](db: Session, model: type[T], entity_id: UUID) -> T:
    db.expire_all()
    entity = db.get(model, entity_id)
    assert entity is not None
    return entity


# ---- visits -------------------------------------------------------------------------------------


def signed_in(make_client: Any, user: User) -> Api:
    """A separate client (own cookie jar) signed in as `user`."""
    api = Api(make_client())
    response = api.login(user.email)
    assert response.status_code == 200, response.text
    return api


def visit_body(
    host_id: UUID,
    start: datetime,
    *,
    minutes: int = 60,
    visitor: dict[str, Any] | None = None,
    visitor_id: UUID | None = None,
    send_invitation: bool = False,
    **extra: Any,
) -> dict[str, Any]:
    body: dict[str, Any] = {
        "host_id": str(host_id),
        "purpose": "Quarterly review",
        "scheduled_start": start.isoformat(),
        "scheduled_end": (start + timedelta(minutes=minutes)).isoformat(),
        "send_invitation": send_invitation,
    }
    if visitor_id is not None:
        body["visitor_id"] = str(visitor_id)
    else:
        body["visitor"] = visitor or {"full_name": "Dana Guest", "email": f"{unique('guest')}@example.com"}
    body.update(extra)
    return body


def create_visit(api: Api, host_id: UUID, start: datetime, **kwargs: Any) -> dict[str, Any]:
    response = api.post("/visits", json=visit_body(host_id, start, **kwargs))
    assert response.status_code == 201, response.text
    result: dict[str, Any] = response.json()
    return result


def create_visit_booked_by(
    db: Session, admin: Api, booker: User, host_id: UUID, start: datetime, **kwargs: Any
) -> dict[str, Any]:
    """A visit that `booker`, an employee, booked for another host. Since B10-24 only administrators book
    for someone else, but visits employees booked for colleagues before that remain, and both the host
    and the creator still own them (contract §7.5). The visit is created by the administrator `admin` and
    then attributed to `booker` exactly as such a visit is stored (`created_by_id`); the returned
    payload still names the administrator as its creator."""
    result = create_visit(admin, host_id, start, **kwargs)
    db.execute(update(Visit).where(Visit.id == UUID(result["visit"]["id"])).values(created_by_id=booker.id))
    db.commit()
    return result


def pass_token(pass_url: str) -> str:
    return pass_url.split("#", 1)[1]


# ---- reception ----------------------------------------------------------------------------------


def check_in(api: Api, visit_id: str, method: str = "MANUAL", **body: Any) -> httpx.Response:
    return api.post(f"/visits/{visit_id}/check-in", json={"method": method, **body})


def check_out(api: Api, visit_id: str, method: str = "MANUAL", **body: Any) -> httpx.Response:
    return api.post(f"/visits/{visit_id}/check-out", json={"method": method, **body})


def walk_in_body(host_id: UUID, expected_end: datetime, **extra: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "visitor": {"full_name": "Walk-in Guest"},
        "host_id": str(host_id),
        "purpose": "Delivery of documents",
        "expected_end": expected_end.isoformat(),
        "reason": "NO_INVITATION",
    }
    body.update(extra)
    return body
