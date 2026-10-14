"""Visit schemas (contract §8 /visits, §8.1 `Visit`, `VisitCreate`, `VisitCreateResult`, `WalkInCreate`)."""

from typing import Annotated, ClassVar, Literal, Self
from uuid import UUID

from pydantic import ConfigDict, Field, ValidationError, ValidationInfo, field_validator, model_validator
from pydantic_core import InitErrorDetails

from app.core.field_errors import FieldCode, FieldProblem, FieldValueError
from app.schemas.common import (
    CheckInMethod,
    CheckOutMethod,
    DateRangeQuery,
    DepartmentRef,
    InvitationStatus,
    Name200,
    NotNull,
    OptionalEmailAddress,
    OptionalName200,
    OptionalReason300,
    PageQuery,
    PassRevokeReason,
    PassStatus,
    Phone,
    Purpose,
    Reason300,
    RequestDatetime,
    RequestModel,
    ResponseModel,
    ScannerInput,
    SearchText,
    UserRef,
    UTCDatetime,
    VisitStatus,
    comma_separated,
)

# ---- responses ----------------------------------------------------------------------------------


class VisitVisitor(ResponseModel):
    """Snapshot of the visitor at creation/check-in (D-17)."""

    id: UUID
    full_name: str
    company_name: str | None


class VisitHost(ResponseModel):
    """`full_name` is the snapshot; `phone` is the host's current phone (D-26)."""

    id: UUID
    full_name: str
    phone: str | None


class VisitInvitation(ResponseModel):
    """Latest VISITOR_INVITATION e-mail of the visit."""

    status: InvitationStatus
    to_email: str | None
    attempts: int
    last_attempt_at: UTCDatetime | None
    sent_at: UTCDatetime | None
    error: str | None


NoticeKind = Literal["VISIT_CANCELLED", "VISIT_RESCHEDULED"]
NoticeStatus = Literal["PENDING", "SENT", "FAILED"]


class VisitNotice(ResponseModel):
    """Latest VISIT_CANCELLED / VISIT_RESCHEDULED e-mail to the visitor (B57-03): whether the visitor was
    told about the change, and if not, why. `error` is set while the notice is not SENT."""

    kind: NoticeKind
    status: NoticeStatus
    to_email: str
    sent_at: UTCDatetime | None
    error: str | None


class VisitPass(ResponseModel):
    status: PassStatus
    issued_at: UTCDatetime | None
    revoke_reason: PassRevokeReason | None


class VisitPermissions(ResponseModel):
    can_edit: bool
    can_cancel: bool
    can_resend: bool
    can_check_in: bool
    can_check_out: bool


class Visit(ResponseModel):
    id: UUID
    status: VisitStatus
    visitor: VisitVisitor
    host: VisitHost
    department: DepartmentRef | None
    purpose: str
    scheduled_start: UTCDatetime
    scheduled_end: UTCDatetime
    window_start: UTCDatetime
    window_end: UTCDatetime
    is_walk_in: bool
    walk_in_reason: str | None
    check_in_at: UTCDatetime | None
    check_in_method: CheckInMethod | None
    check_in_note: str | None
    checked_in_by: UserRef | None
    check_out_at: UTCDatetime | None
    check_out_method: CheckOutMethod | None
    check_out_note: str | None
    checked_out_by: UserRef | None
    cancelled_at: UTCDatetime | None
    cancellation_reason: str | None
    cancelled_by: UserRef | None
    no_show_at: UTCDatetime | None
    duration_seconds: int | None
    is_overdue: bool  # CHECKED_IN and now > scheduled_end
    is_stale: bool  # CHECKED_IN and checked in before company-local today
    created_by: UserRef
    created_at: UTCDatetime
    updated_at: UTCDatetime
    invitation: VisitInvitation
    last_notice: VisitNotice | None
    # "pass" is a Python keyword: exposed under that name through the alias.
    pass_: VisitPass = Field(alias="pass", serialization_alias="pass")
    permissions: VisitPermissions

    # Spelled out (not merged from ResponseModel.model_config) so the Pydantic mypy plugin sees that the
    # constructor takes `pass_`.
    model_config = ConfigDict(
        from_attributes=True, validate_by_name=True, validate_by_alias=True, serialize_by_alias=True
    )


class VisitorMatch(ResponseModel):
    reused: bool


class VisitCreateResult(ResponseModel):
    visit: Visit
    pass_url: str  # shown exactly once; never retrievable later
    visitor_match: VisitorMatch


class VisitPassResult(ResponseModel):
    """POST /visits/{id}/pass (B57-04): a new pass for the host to share; the previous one stops working."""

    visit: Visit
    pass_url: str  # shown exactly once; never retrievable later


# ---- requests -----------------------------------------------------------------------------------


class VisitorInput(RequestModel):
    """Inline visitor for visit creation / walk-ins (deduplicated by e-mail within the company)."""

    full_name: Name200
    email: OptionalEmailAddress = None
    phone: Phone = None
    company_name: OptionalName200 = None


VISITOR_SOURCE_MISSING = FieldProblem(
    FieldCode.VISITOR_REQUIRED, "Choose an existing visitor or enter the visitor's details."
)
VISITOR_SOURCE_BOTH = FieldProblem(
    FieldCode.VISITOR_BOTH, "Provide either an existing visitor or new visitor details, not both."
)
WALK_IN_REASON_NOTE_REQUIRED = FieldProblem(FieldCode.REQUIRED, "Describe the reason for this walk-in.")


class VisitorSourceRequest(RequestModel):
    """Base of requests that name their visitor: exactly one of an existing visitor (`visitor_id`) or
    inline details (`visitor`). Subclasses add their own fields after these two.

    The rule is a model validator: it runs only once every field is valid, so a malformed `visitor_id`
    is reported on its own instead of also triggering this rule. Problems are reported on `visitor`, the
    field the form shows.
    """

    visitor_id: UUID | None = None
    visitor: VisitorInput | None = None

    @model_validator(mode="after")
    def _exactly_one_visitor(self) -> Self:
        if self.visitor_id is None and self.visitor is None:
            raise _field_error("visitor", VISITOR_SOURCE_MISSING)
        if self.visitor_id is not None and self.visitor is not None:
            raise _field_error("visitor", VISITOR_SOURCE_BOTH)
        return self


def _field_error(field: str, problem: FieldProblem) -> ValidationError:
    """A validation error located at `field` (a model validator's own errors have no location), shaped
    like the error of a validator that raised `FieldValueError(problem)`."""
    return ValidationError.from_exception_data(
        "VisitorSourceRequest",
        [
            InitErrorDetails(
                type="value_error", loc=(field,), input=None, ctx={"error": FieldValueError(problem)}
            )
        ],
    )


class VisitCreate(VisitorSourceRequest):
    host_id: UUID
    department_id: UUID | None = None
    purpose: Purpose
    scheduled_start: RequestDatetime
    scheduled_end: RequestDatetime
    send_invitation: bool


class VisitUpdate(RequestModel):
    """PATCH while SCHEDULED: omitted fields are unchanged; `department_id` may be null to clear it."""

    purpose: Annotated[Purpose | None, NotNull] = None
    department_id: UUID | None = None
    scheduled_start: Annotated[RequestDatetime | None, NotNull] = None
    scheduled_end: Annotated[RequestDatetime | None, NotNull] = None


class VisitCancel(RequestModel):
    reason: OptionalReason300 = None
    notify_visitor: bool = True


class QrCheckIn(RequestModel):
    """`pass_token` as scanned or pasted, like `ScanRequest.token`: an invalid pass is 404 PASS_INVALID."""

    unchecked_text_fields: ClassVar[frozenset[str]] = frozenset({"pass_token"})

    method: Literal["QR"]
    pass_token: ScannerInput


class ManualCheckIn(RequestModel):
    method: Literal["MANUAL"]


class OverrideCheckIn(RequestModel):
    method: Literal["OVERRIDE"]
    reason: Reason300


CheckInRequest = Annotated[QrCheckIn | ManualCheckIn | OverrideCheckIn, Field(discriminator="method")]


class QrCheckOut(RequestModel):
    """`pass_token` as scanned or pasted, like `ScanRequest.token`: an invalid pass is 404 PASS_INVALID."""

    unchecked_text_fields: ClassVar[frozenset[str]] = frozenset({"pass_token"})

    method: Literal["QR"]
    pass_token: ScannerInput


class ManualCheckOut(RequestModel):
    method: Literal["MANUAL"]


class CorrectedCheckOut(RequestModel):
    method: Literal["CORRECTED"]
    check_out_at: RequestDatetime
    note: Reason300


CheckOutRequest = Annotated[QrCheckOut | ManualCheckOut | CorrectedCheckOut, Field(discriminator="method")]

WalkInReason = Literal["NO_INVITATION", "EARLY_ARRIVAL", "LATE_ARRIVAL", "LOST_PASS", "DELIVERY", "OTHER"]


class WalkInCreate(VisitorSourceRequest):
    host_id: UUID
    department_id: UUID | None = None
    purpose: Purpose
    expected_end: RequestDatetime
    reason: WalkInReason
    reason_note: OptionalReason300 = Field(default=None, validate_default=True)

    @field_validator("reason_note")
    @classmethod
    def _note_for_other(cls, value: str | None, info: ValidationInfo) -> str | None:
        if info.data.get("reason") == "OTHER" and value is None:
            raise FieldValueError(WALK_IN_REASON_NOTE_REQUIRED)
        return value


# ---- query parameters ---------------------------------------------------------------------------

VisitScope = Literal["mine", "all"]
SortOrder = Literal["asc", "desc"]
VisitStatusFilter = Annotated[list[VisitStatus], comma_separated(VisitStatus)]


class VisitListQuery(PageQuery, DateRangeQuery):
    """GET /visits. Filters narrow the caller's scope and never widen it: for EMPLOYEE-only callers
    `scope` is always `mine` and `host_id` is intersected with their own visits (§7.5). `date_from` /
    `date_to` are company-local dates of `scheduled_start`; `scope` and `order` default per view in the
    service."""

    scope: VisitScope | None = None
    status: VisitStatusFilter = Field(default_factory=list)
    host_id: UUID | None = None
    visitor_id: UUID | None = None
    department_id: UUID | None = None
    needs_attention: bool = False
    q: SearchText = None
    order: SortOrder | None = None
