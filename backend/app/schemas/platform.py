"""Schemas of the platform owner's API (/api/v1/platform, Phase 11, docs/decisions/phase-11-backend.md).

Sign-in, sign-out, password change and preferences take the tenant API's bodies (`LoginRequest`,
`ChangePasswordRequest`, `PreferencesUpdate`); the responses and the company bodies are here.
"""

from typing import Annotated, Any
from uuid import UUID

from pydantic import AfterValidator, StringConstraints

from app.core.field_errors import FieldCode, FieldProblem, FieldValueError
from app.core.text import is_company_slug
from app.models import Company
from app.models import PlatformAuditLog as PlatformAuditLogRow
from app.models.enums import Language
from app.schemas.audit import AuditActionFilter
from app.schemas.brand import CompanyBrand
from app.schemas.common import (
    EmailAddress,
    Name200,
    NotNull,
    OptionalName200,
    PageQuery,
    RequestModel,
    ResponseModel,
    SearchText,
    SecretInput,
    UTCDatetime,
)
from app.schemas.company import TimezoneName

INVALID_SLUG = FieldProblem(
    FieldCode.INVALID_FORMAT,
    "Use lowercase letters, digits and hyphens, starting and ending with a letter or digit.",
)


def _slug(value: str) -> str:
    if not is_company_slug(value):
        raise FieldValueError(INVALID_SLUG)
    return value


# A company's short identifier (1-80 characters): lowercase letters, digits and inner hyphens. It never
# changes after creation (B11-12).
Slug = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=80), AfterValidator(_slug)
]


# ---- the signed-in platform administrator ------------------------------------------------------


class PlatformAdminProfile(ResponseModel):
    id: UUID
    full_name: str
    email: str
    must_change_password: bool
    # The platform pages' language; null follows the device (B11-7).
    preferred_language: Language | None


class PlatformMe(ResponseModel):
    """GET /platform/auth/me: who is signed in to the platform (401 when nobody is)."""

    admin: PlatformAdminProfile


# ---- companies ---------------------------------------------------------------------------------


class CompanyCounts(ResponseModel):
    """What the platform owner may know about a company's use (B11-2)."""

    active_users: int
    visits_last_30_days: int  # visits scheduled to start in the 30 days up to now


class PlatformCompany(ResponseModel):
    id: UUID
    name: str
    name_ar: str | None
    slug: str
    timezone: str
    default_language: Language
    is_active: bool
    deactivated_at: UTCDatetime | None
    created_at: UTCDatetime
    updated_at: UTCDatetime
    counts: CompanyCounts
    brand: CompanyBrand  # its logo, icon, colour and palette (B12-7): a list can show the logo

    @classmethod
    def build(cls, company: Company, counts: CompanyCounts, brand: CompanyBrand) -> PlatformCompany:
        return cls(
            id=company.id,
            name=company.name,
            name_ar=company.name_ar,
            slug=company.slug,
            timezone=company.timezone,
            default_language=Language(company.default_language),
            is_active=company.is_active,
            deactivated_at=company.deactivated_at,
            created_at=company.created_at,
            updated_at=company.updated_at,
            counts=counts,
            brand=brand,
        )


class PlatformCompanyAdmin(ResponseModel):
    """One of a company's administrators (SYSTEM_ADMIN), the only users the platform owner sees."""

    id: UUID
    full_name: str
    email: str
    is_active: bool
    must_change_password: bool
    last_login_at: UTCDatetime | None
    created_at: UTCDatetime


class PlatformCompanyCreated(ResponseModel):
    """POST /platform/companies: the company and its first administrator."""

    company: PlatformCompany
    admin: PlatformCompanyAdmin


class CompanyAdminCreate(RequestModel):
    """A company administrator created by the platform owner: a SYSTEM_ADMIN who must change the
    temporary password at the first sign-in (72 hours, D-11), like POST /users."""

    full_name: Name200
    email: EmailAddress
    temporary_password: SecretInput


class PlatformCompanyCreate(RequestModel):
    name: Name200
    name_ar: OptionalName200 = None
    slug: Slug
    timezone: TimezoneName
    default_language: Language
    admin: CompanyAdminCreate


class PlatformCompanyUpdate(RequestModel):
    """PATCH: the company's identity. Omitted fields are unchanged; `name_ar` may be null (or blank) to
    clear it. The slug never changes (B11-12)."""

    name: Annotated[Name200 | None, NotNull] = None
    name_ar: OptionalName200 = None
    timezone: Annotated[TimezoneName | None, NotNull] = None
    default_language: Annotated[Language | None, NotNull] = None


class AdminPasswordResetSent(ResponseModel):
    """POST /platform/companies/{id}/admins/{user_id}/password-reset: the reset link went to this address."""

    sent_to: str


class PlatformCompanyListQuery(PageQuery):
    """GET /platform/companies: `q` matches the name, the Arabic name or the slug."""

    q: SearchText = None
    is_active: bool | None = None


# ---- the platform's audit trail -----------------------------------------------------------------


class PlatformActorRef(ResponseModel):
    id: UUID
    full_name: str


class CompanyRef(ResponseModel):
    id: UUID
    name: str
    name_ar: str | None


class PlatformAuditLogQuery(PageQuery):
    """GET /platform/audit-logs: newest first; `company_id` keeps the rows about that company."""

    company_id: UUID | None = None
    action: AuditActionFilter | None = None


class PlatformAuditLog(ResponseModel):
    id: UUID
    seq: int
    created_at: UTCDatetime
    action: str
    actor: PlatformActorRef | None  # the platform administrator, null for the CLI and unattributed events
    company: CompanyRef | None  # the company the row is about, if any
    entity_type: str | None
    entity_id: UUID | None
    metadata: dict[str, Any]
    ip_address: str | None
    user_agent: str | None
    request_id: str | None

    @classmethod
    def from_row(
        cls, row: PlatformAuditLogRow, *, actor: PlatformActorRef | None, company: CompanyRef | None
    ) -> PlatformAuditLog:
        return cls(
            id=row.id,
            seq=row.seq,
            created_at=row.created_at,
            action=row.action,
            actor=actor,
            company=company,
            entity_type=row.entity_type,
            entity_id=row.entity_id,
            metadata=dict(row.meta),
            ip_address=str(row.ip_address) if row.ip_address is not None else None,
            user_agent=row.user_agent,
            request_id=row.request_id,
        )
