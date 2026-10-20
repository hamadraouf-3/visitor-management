"""Authentication schemas (contract §8 auth endpoints, §8.1 `Me`)."""

from typing import Annotated
from uuid import UUID

from pydantic import StringConstraints

from app.models.enums import Language
from app.schemas.brand import CompanyBrand
from app.schemas.common import (
    DepartmentRef,
    LoginEmail,
    Message,
    RequestModel,
    ResponseModel,
    RoleList,
    SecretInput,
)


class LoginRequest(RequestModel):
    # Not validated as an address: any input is normalised and simply fails to match (401).
    email: LoginEmail
    password: SecretInput


class MeUser(ResponseModel):
    id: UUID
    full_name: str
    email: str
    phone: str | None
    roles: RoleList
    department: DepartmentRef | None
    must_change_password: bool
    # The user's own language; null follows `company.default_language` (B10-1).
    preferred_language: Language | None


class MeCompany(ResponseModel):
    id: UUID
    name: str  # the English (or only) name
    name_ar: str | None  # shown instead of `name` when the interface is in Arabic
    slug: str  # the company's own sign-in page is /c/<slug> (B12-11)
    # The company's address, the location of its visits' calendar events (Phase 14, B14-8): `address_ar`
    # is shown in Arabic when it is set, `address` in English, each falling back to the other.
    address: str | None
    address_ar: str | None
    timezone: str
    default_language: Language
    brand: CompanyBrand  # its logo, icon, colour and palette (B12-11)


class Me(ResponseModel):
    user: MeUser
    company: MeCompany


class PreferencesUpdate(RequestModel):
    """PATCH /auth/preferences: the caller's interface and e-mail language (B10-3)."""

    language: Language


class ChangePasswordRequest(RequestModel):
    current_password: SecretInput
    new_password: SecretInput


class ForgotPasswordRequest(RequestModel):
    email: LoginEmail


ForgotPasswordResponse = Message


class ResetPasswordRequest(RequestModel):
    token: Annotated[str, StringConstraints(min_length=1, max_length=256)]
    new_password: SecretInput
