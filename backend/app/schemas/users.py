"""User and host schemas (contract §8 /users, §8.1 `User`, `Host`)."""

from typing import Annotated
from uuid import UUID

from pydantic import Field, field_validator

from app.core.field_errors import FieldCode, FieldProblem, FieldValueError
from app.schemas.common import (
    DepartmentRef,
    EmailAddress,
    Name200,
    NotNull,
    PageQuery,
    Phone,
    QueryModel,
    RequestModel,
    ResponseModel,
    Role,
    RoleList,
    SearchText,
    SecretInput,
    UTCDatetime,
    comma_separated,
)

HOSTS_MAX_RESULTS = 50

# Request role list: at least one role, no duplicates (rejected rather than silently collapsed).
RequestRoles = Annotated[list[Role], Field(min_length=1, max_length=len(Role))]
DUPLICATE_ROLES = FieldProblem(FieldCode.DUPLICATES, "Roles must not contain duplicates.")


def _reject_duplicate_roles(roles: list[Role] | None) -> list[Role] | None:
    if roles is not None and len(set(roles)) != len(roles):
        raise FieldValueError(DUPLICATE_ROLES)
    return roles


class User(ResponseModel):
    id: UUID
    full_name: str
    email: str
    phone: str | None
    roles: RoleList
    department: DepartmentRef | None
    is_active: bool
    must_change_password: bool
    last_login_at: UTCDatetime | None
    created_at: UTCDatetime
    updated_at: UTCDatetime
    # Present only when an update cancelled the user's hosted visits (D-18).
    cancelled_visits: int | None = Field(default=None, exclude_if=lambda value: value is None)


class Host(ResponseModel):
    id: UUID
    full_name: str
    phone: str | None
    department: DepartmentRef | None


class UserCreate(RequestModel):
    full_name: Name200
    email: EmailAddress
    phone: Phone = None
    roles: RequestRoles
    department_id: UUID | None = None
    temporary_password: SecretInput

    _unique_roles = field_validator("roles")(_reject_duplicate_roles)


class UserUpdate(RequestModel):
    """PATCH: omitted fields are unchanged; `phone`/`department_id` may be set to null to clear them."""

    full_name: Annotated[Name200 | None, NotNull] = None
    phone: Phone = None
    department_id: UUID | None = None
    roles: Annotated[RequestRoles | None, NotNull] = None
    is_active: Annotated[bool | None, NotNull] = None

    _unique_roles = field_validator("roles")(_reject_duplicate_roles)


# ---- query parameters ---------------------------------------------------------------------------


RoleFilter = Annotated[list[Role], comma_separated(Role)]


class HostSearchQuery(QueryModel):
    """GET /users/hosts: matches the host's name only (B1-38)."""

    q: SearchText = None


class UserListQuery(PageQuery):
    """GET /users (administrators): `q` matches name or e-mail; `role` keeps users holding any of the
    given roles."""

    q: SearchText = None
    role: RoleFilter = Field(default_factory=list)
    is_active: bool | None = None
