"""Visitor schemas (contract §8 /visitors, §8.1 `Visitor`, `VisitorSearchItem`)."""

from typing import Annotated
from uuid import UUID

from app.schemas.common import (
    Name200,
    NotNull,
    OptionalEmailAddress,
    OptionalName200,
    PageQuery,
    Phone,
    RequestModel,
    ResponseModel,
    SearchText,
    UTCDatetime,
)
from app.schemas.visits import Visit


class VisitorStats(ResponseModel):
    """Computed within the caller's visibility scope."""

    total_visits: int
    last_visit_at: UTCDatetime | None


class VisitorPermissions(ResponseModel):
    can_edit: bool


class Visitor(ResponseModel):
    id: UUID
    full_name: str
    email: str | None
    phone: str | None
    company_name: str | None
    created_at: UTCDatetime
    updated_at: UTCDatetime
    stats: VisitorStats
    permissions: VisitorPermissions


class VisitorSearchItem(Visitor):
    today_visits: list[Visit]  # SCHEDULED/CHECKED_IN visits today, within scope


class VisitorCreate(RequestModel):
    full_name: Name200
    email: OptionalEmailAddress = None
    phone: Phone = None
    company_name: OptionalName200 = None


class VisitorUpdate(RequestModel):
    """PATCH: omitted fields are unchanged; email/phone/company_name may be null to clear them."""

    full_name: Annotated[Name200 | None, NotNull] = None
    email: OptionalEmailAddress = None
    phone: Phone = None
    company_name: OptionalName200 = None


class VisitorSearchQuery(PageQuery):
    """GET /visitors: normalised search over name, e-mail and company, plus phone digits (§4)."""

    q: SearchText = None
