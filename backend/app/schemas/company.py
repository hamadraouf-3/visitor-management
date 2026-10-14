"""Company settings schemas (contract §8 /company/settings, §8.1 `CompanySettings`)."""

from typing import Annotated
from uuid import UUID

from pydantic import AfterValidator, Field, StringConstraints

from app.core.policy import GRACE_MINUTES_MAX
from app.core.text import normalise_domain_name
from app.models.enums import Language
from app.schemas.common import BLANK_TO_NONE, Name200, NotNull, OptionalName200, RequestModel, ResponseModel


def _email_domain(value: str | None) -> str | None:
    return None if value is None else normalise_domain_name(value)


GraceMinutes = Annotated[int, Field(ge=0, le=GRACE_MINUTES_MAX)]
TimezoneName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=64)]
Address = Annotated[Annotated[str, StringConstraints(max_length=1000)] | None, BLANK_TO_NONE]
EmailDomain = Annotated[
    Annotated[Annotated[str, StringConstraints(max_length=255)] | None, BLANK_TO_NONE],
    AfterValidator(_email_domain),
]


class CompanySettings(ResponseModel):
    id: UUID
    name: str
    name_ar: str | None
    default_language: Language
    timezone: str
    address: str | None
    address_ar: str | None  # the address in Arabic (B10-25), shown instead of `address` in Arabic
    email_domain: str | None
    pass_grace_before_minutes: int
    pass_grace_after_minutes: int
    notify_host_on_check_in: bool
    allow_walk_ins: bool


class CompanySettingsUpdate(RequestModel):
    """PATCH: omitted fields are unchanged; `name_ar`, `address`, `address_ar` and `email_domain` may be
    null (or blank) to clear them. `name_ar` follows the rules of `name` (trimmed, 1-200 characters, one
    line, no control or text-direction characters), `address_ar` those of `address`."""

    name: Annotated[Name200 | None, NotNull] = None
    name_ar: OptionalName200 = None
    default_language: Annotated[Language | None, NotNull] = None
    timezone: Annotated[TimezoneName | None, NotNull] = None
    address: Address = None
    address_ar: Address = None
    email_domain: EmailDomain = None
    pass_grace_before_minutes: Annotated[GraceMinutes | None, NotNull] = None
    pass_grace_after_minutes: Annotated[GraceMinutes | None, NotNull] = None
    notify_host_on_check_in: Annotated[bool | None, NotNull] = None
    allow_walk_ins: Annotated[bool | None, NotNull] = None
