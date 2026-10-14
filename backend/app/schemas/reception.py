"""Reception schemas (contract §6, §8 /reception, §8.1 `ScanResult`, `ReceptionToday`)."""

from datetime import date
from typing import ClassVar, Literal

from pydantic import Field

from app.schemas.common import Reason300, RequestModel, ResponseModel, ScannerInput
from app.schemas.visits import Visit, VisitVisitor

CheckInOption = Literal["MANUAL", "OVERRIDE"]
LIST_CAP = 200


class ScanRequest(RequestModel):
    """A pass URL or a bare token exactly as scanned or pasted; input that is not a valid pass is
    answered 404 PASS_INVALID (contract §6), not 422."""

    unchecked_text_fields: ClassVar[frozenset[str]] = frozenset({"token"})

    token: ScannerInput


class ScanWarning(ResponseModel):
    code: Literal["OUTSIDE_SCHEDULED_TIME", "OVERSTAYED"]
    message: str


class ScanActions(ResponseModel):
    check_in: bool
    check_out: bool


class ScanResult(ResponseModel):
    result: Literal["READY", "ALREADY_CHECKED_IN"]
    visit: Visit
    warnings: list[ScanWarning]
    actions: ScanActions


class ScanErrorDetails(ResponseModel):
    """`error.details` of the scan error responses in contract §6 rows 2-8."""

    visit: Visit | None = Field(default=None, exclude_if=lambda value: value is None)
    check_in_options: list[CheckInOption] | None = Field(default=None, exclude_if=lambda value: value is None)


class ReceptionCounts(ResponseModel):
    expected: int
    inside: int
    checked_out: int
    no_show: int
    cancelled: int
    walk_ins: int


class ReceptionToday(ResponseModel):
    date: date  # company-local YYYY-MM-DD
    counts: ReceptionCounts  # exact
    expected: list[Visit]  # each list capped at LIST_CAP
    inside: list[Visit]
    checked_out: list[Visit]
    no_show: list[Visit]


class InsideVisitor(VisitVisitor):
    """The visitor of an evacuation-list entry: the visit's snapshot (D-17) plus the visitor record's
    current phone, like `host.phone` (B57-72), so staff at the assembly point can call a missing
    visitor."""

    phone: str | None


class InsideVisit(Visit):
    """`Visit` on the evacuation list (B57-72); only `visitor` differs."""

    visitor: InsideVisitor


class InsideList(ResponseModel):
    count: int
    items: list[InsideVisit]


class StaleCheckOutRequest(RequestModel):
    reason: Reason300


class StaleCheckOutResult(ResponseModel):
    checked_out: int
