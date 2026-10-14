"""Department schemas (contract §8 /departments, §8.1 `Department`).

`name` is the default (English, or only) name; `name_ar` the Arabic name, shown instead of it when the
interface is in Arabic (B10-25). Both are unique per company ignoring case (409 CONFLICT on `name` or
`name_ar`); `name_ar` follows the rules of `name` and may be null.
"""

from typing import Annotated
from uuid import UUID

from app.schemas.common import (
    DepartmentName,
    NotNull,
    OptionalDepartmentName,
    QueryModel,
    RequestModel,
    ResponseModel,
    UTCDatetime,
)


class Department(ResponseModel):
    id: UUID
    name: str
    name_ar: str | None
    is_active: bool
    created_at: UTCDatetime
    updated_at: UTCDatetime


class DepartmentCreate(RequestModel):
    name: DepartmentName
    name_ar: OptionalDepartmentName = None


class DepartmentUpdate(RequestModel):
    """PATCH: omitted fields are unchanged; `name_ar` may be null (or blank) to clear it."""

    name: Annotated[DepartmentName | None, NotNull] = None
    name_ar: OptionalDepartmentName = None
    is_active: Annotated[bool | None, NotNull] = None


class DepartmentListQuery(QueryModel):
    include_inactive: bool = False  # administrators only (B1-19)
