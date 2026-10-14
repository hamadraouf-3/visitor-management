"""Shared schema building blocks (contract §8.1).

Responses serialise every instant as UTC `…Z`; requests accept only timezone-aware ISO-8601 instants
(naive values are a 422). Request models forbid unknown fields so typos are reported, not ignored, and
reject control characters in every string field. Free text (names, purposes, reasons, notes) is trimmed
of white space and invisible characters at both ends (`strip_invisible`), so a required value must show
something.

PATCH models mark fields that may be omitted but not set to null with `NotNull`:
`name: Annotated[DepartmentName | None, NotNull] = None`.

Scanner input (`ScanRequest.token`, `pass_token` of QR check-in/out) is `ScannerInput`: only a hard size
cap, no trimming and no control-character rule, and the model lists it in `unchecked_text_fields`. The
service classifies everything else (contract §6 row 1: 404 PASS_INVALID, audited), so malformed scans
never turn into a 422.

Query parameters are models too (`QueryModel`, declared as `Annotated[Model, Query()]`): one per
endpoint, mirrored by the `*Params` interfaces of the frontend and published in the contract snapshot.
Like bodies, they reject unknown parameters. Multi-value filters are
`Annotated[list[Enum], comma_separated(Enum)]` (`status=SCHEDULED,CHECKED_IN`, contract §8); repeating
the parameter works as well.
"""

import re
import unicodedata
from collections.abc import Iterable
from datetime import UTC, date, datetime
from enum import StrEnum
from typing import Annotated, Any, ClassVar, Literal
from uuid import UUID

from pydantic import (
    AfterValidator,
    AwareDatetime,
    BaseModel,
    BeforeValidator,
    ConfigDict,
    Field,
    StringConstraints,
    ValidationInfo,
    WithJsonSchema,
    field_validator,
)

from app.core.field_errors import FieldCode, FieldProblem, FieldValueError
from app.core.text import (
    CONTROL_CHARACTERS,
    EMAIL_MAX_LENGTH,
    has_control_characters,
    validate_email_address,
)
from app.models.enums import (
    CheckInMethod,
    CheckOutMethod,
    PassRevokeReason,
    Role,
    VisitStatus,
)

__all__ = [
    "CheckInMethod",
    "CheckOutMethod",
    "CompanyLocalDate",
    "DateRangeQuery",
    "DepartmentName",
    "DepartmentRef",
    "EmailAddress",
    "ErrorBody",
    "ErrorEnvelope",
    "InvitationStatus",
    "LoginEmail",
    "Message",
    "Name200",
    "NotNull",
    "OptionalDepartmentName",
    "OptionalEmailAddress",
    "OptionalName200",
    "OptionalReason300",
    "PageQuery",
    "Paginated",
    "PassRevokeReason",
    "PassStatus",
    "Phone",
    "Purpose",
    "QueryModel",
    "Reason300",
    "RequestDatetime",
    "RequestModel",
    "ResponseModel",
    "Role",
    "RoleList",
    "ScannerInput",
    "SearchText",
    "SecretInput",
    "UTCDatetime",
    "UserRef",
    "VisitStatus",
    "comma_separated",
]


# Dates and instants a request may carry. Python's `datetime` ends at year 9999 and starts at year 1, so
# converting an extreme value to UTC, or adding the day or the grace period the services add, would
# overflow (a 500). Far narrower than that, far wider than any visit, report or audit filter needs.
EARLIEST_REQUEST_DATE = date(1900, 1, 1)
LATEST_REQUEST_DATE = date(9998, 12, 31)
DATE_OUT_OF_RANGE = f"Enter a date between {EARLIEST_REQUEST_DATE} and {LATEST_REQUEST_DATE}."
DATETIME_OUT_OF_RANGE = f"Enter a date and time between {EARLIEST_REQUEST_DATE} and {LATEST_REQUEST_DATE}."
_REQUEST_DATES = {"min": EARLIEST_REQUEST_DATE.isoformat(), "max": LATEST_REQUEST_DATE.isoformat()}
DATE_OUT_OF_RANGE_PROBLEM = FieldProblem(FieldCode.DATE_OUT_OF_RANGE, DATE_OUT_OF_RANGE, _REQUEST_DATES)
DATETIME_OUT_OF_RANGE_PROBLEM = FieldProblem(
    FieldCode.DATETIME_OUT_OF_RANGE, DATETIME_OUT_OF_RANGE, _REQUEST_DATES
)
OFFSET_REQUIRED = FieldProblem(
    FieldCode.OFFSET_REQUIRED, "Include a time zone, e.g. 2026-10-05T09:00:00+03:00."
)


def _to_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        raise FieldValueError(OFFSET_REQUIRED)  # AwareDatetime refuses it first
    try:
        instant = value.astimezone(UTC)
    except OverflowError:  # e.g. 0001-01-01T00:00:00+03:00 is in year 0 in UTC
        raise FieldValueError(DATETIME_OUT_OF_RANGE_PROBLEM) from None
    if not EARLIEST_REQUEST_DATE <= instant.date() <= LATEST_REQUEST_DATE:
        raise FieldValueError(DATETIME_OUT_OF_RANGE_PROBLEM)
    return instant


def _within_request_dates(value: date) -> date:
    if not EARLIEST_REQUEST_DATE <= value <= LATEST_REQUEST_DATE:
        raise FieldValueError(DATE_OUT_OF_RANGE_PROBLEM)
    return value


def _as_utc(value: datetime) -> datetime:
    return value if value.tzinfo is UTC else value.astimezone(UTC)


# Response instant: always rendered as UTC with a `Z` suffix. The instant is converted to UTC when the
# model is built (a no-op for what the database and the clock give: the sessions' time zone is pinned to
# UTC, `db.session.SESSION_SETTINGS`), and Pydantic renders a UTC instant with `Z` itself. A serialiser
# function per instant, as before, cost about 4 ms of CPU for the ~2,100 instants of an ordinary
# GET /reception/today (re-audit round 1). The published schema stays a plain string, as before.
UTCDatetime = Annotated[
    datetime, AfterValidator(_as_utc), WithJsonSchema({"type": "string"}, mode="serialization")
]
# Request instant: must carry an offset; normalised to UTC; within the request date range.
RequestDatetime = Annotated[AwareDatetime, AfterValidator(_to_utc)]
# Company-local calendar date `YYYY-MM-DD` (date-only filters, report ranges), within the request date
# range: the services turn it into the UTC bounds of that day and the next.
CompanyLocalDate = Annotated[date, AfterValidator(_within_request_dates)]


# Characters that show nothing on their own: Unicode's Default_Ignorable_Code_Point set
# (DerivedCoreProperties.txt) plus U+2800 BRAILLE PATTERN BLANK, which renders as an empty cell. White space
# (`str.isspace`) is checked separately. Code point ranges, not `unicodedata.category`, because the set
# mixes categories (Cf, Lo, Mn, Cn) and some format characters are visible (U+0600 ARABIC NUMBER SIGN).
_STANDALONE_INVISIBLE_RANGES = (
    (0x00AD, 0x00AD),  # SOFT HYPHEN
    (0x061C, 0x061C),  # ARABIC LETTER MARK
    (0x115F, 0x1160),  # HANGUL CHOSEONG FILLER, HANGUL JUNGSEONG FILLER
    (0x180E, 0x180E),  # MONGOLIAN VOWEL SEPARATOR
    (0x200B, 0x200F),  # ZERO WIDTH SPACE, ZWNJ, ZWJ, LEFT-TO-RIGHT MARK, RIGHT-TO-LEFT MARK
    (0x202A, 0x202E),  # bidirectional embeddings and overrides
    (0x2060, 0x206F),  # WORD JOINER, invisible operators, bidirectional isolates, deprecated formats
    (0x2800, 0x2800),  # BRAILLE PATTERN BLANK
    (0x3164, 0x3164),  # HANGUL FILLER
    (0xFEFF, 0xFEFF),  # ZERO WIDTH NO-BREAK SPACE (byte order mark)
    (0xFFA0, 0xFFA0),  # HALFWIDTH HANGUL FILLER
    (0xFFF0, 0xFFF8),  # reserved
    (0x1BCA0, 0x1BCA3),  # shorthand format controls
    (0x1D173, 0x1D17A),  # musical symbol format controls
    (0xE0000, 0xE001F),  # LANGUAGE TAG, reserved
    (0xE0080, 0xE00FF),  # reserved
    (0xE01F0, 0xE0FFF),  # reserved
)
# Combining and tag characters: they belong to the visible character before them (U+FE0F gives an emoji
# its colour presentation, tags spell a flag's region), so only a leading one is meaningless.
_ATTACHING_INVISIBLE_RANGES = (
    (0x034F, 0x034F),  # COMBINING GRAPHEME JOINER
    (0x17B4, 0x17B5),  # KHMER VOWEL INHERENT AQ, AA
    (0x180B, 0x180D),  # MONGOLIAN FREE VARIATION SELECTORS ONE to THREE
    (0x180F, 0x180F),  # MONGOLIAN FREE VARIATION SELECTOR FOUR
    (0xFE00, 0xFE0F),  # VARIATION SELECTORS 1 to 16
    (0xE0020, 0xE007F),  # TAG SPACE to CANCEL TAG
    (0xE0100, 0xE01EF),  # VARIATION SELECTORS 17 to 256
)


def _character_class(*ranges: tuple[int, int]) -> re.Pattern[str]:
    return re.compile(
        "[" + "".join(f"{re.escape(chr(low))}-{re.escape(chr(high))}" for low, high in ranges) + "]"
    )


_INVISIBLE_LEADING = _character_class(*_STANDALONE_INVISIBLE_RANGES, *_ATTACHING_INVISIBLE_RANGES)
_INVISIBLE_TRAILING = _character_class(*_STANDALONE_INVISIBLE_RANGES)


def strip_invisible(value: str) -> str:
    """`value` without leading and trailing white space and invisible characters (combining and tag
    characters only at the start). Interior characters are kept: ZWNJ and ZWJ shape Persian and Arabic
    words and join emoji. Text made only of such characters becomes "", so a required field reports
    "This field is required." and an optional one becomes None: a reason, note or name must show
    something. One pass from each end, character by character (no backtracking over the value)."""
    start, end = 0, len(value)
    while start < end and (value[start].isspace() or _INVISIBLE_LEADING.match(value[start])):
        start += 1
    while end > start and (value[end - 1].isspace() or _INVISIBLE_TRAILING.match(value[end - 1])):
        end -= 1
    return value[start:end]


def _strip_text(value: object) -> object:
    if isinstance(value, str):
        return strip_invisible(unicodedata.normalize("NFC", value))
    return value


def _blank_to_none(value: object) -> object:
    value = _strip_text(value)
    if isinstance(value, str) and value == "":
        return None
    return value


# Text aliases are written out (not built by a factory) so type checkers see `str` / `str | None`.
# Required text: trimmed (white space and invisible characters, `strip_invisible`), non-empty, at most N
# characters. The constraints come first so the trimming validator wraps the constrained string schema.
TRIMMED = BeforeValidator(_strip_text)
# Optional text: trimmed the same way; input that shows nothing becomes None (stored as NULL).
BLANK_TO_NONE = BeforeValidator(_blank_to_none)


NOT_NULL = FieldProblem(FieldCode.REQUIRED, "This field cannot be null.")


def _reject_explicit_null(value: object) -> object:
    # Field validators only run for supplied values, so this rejects an explicit null and leaves an
    # omitted field (default None, "unchanged") alone.
    if value is None:
        raise FieldValueError(NOT_NULL)
    return value


NotNull = AfterValidator(_reject_explicit_null)


# Explicit bidirectional embeddings, overrides and isolates (U+202A-U+202E, U+2066-U+2069) reorder the
# characters after them on screen. Inside a name or a phone number they make the text shown differ from
# the text stored: "+962 79 <RLO>2001 005" reads "+962 79 500 1002" but dials +962792001005, and a
# name can read as one that no search finds. Single-line names and phones refuse them; at the ends they
# are trimmed like every invisible character (`strip_invisible`). The marks (LRM, RLM, ALM) stay
# allowed: they only nudge neutral characters and Arabic text needs them.
_BIDI_CONTROLS = re.compile("[\u202a-\u202e\u2066-\u2069]")
BIDI_CONTROLS_MESSAGE = "Remove text-direction control characters."
BIDI_CONTROLS = FieldProblem(FieldCode.BIDI_CONTROLS, BIDI_CONTROLS_MESSAGE)


def _reject_bidi_controls(value: str | None) -> str | None:
    if value is not None and _BIDI_CONTROLS.search(value):
        raise FieldValueError(BIDI_CONTROLS)
    return value


NO_BIDI_CONTROLS = AfterValidator(_reject_bidi_controls)

# Single-line text (names) holds no line or paragraph break and no tab (SEC-34). The request-wide rule
# allows TAB, LF and CR for multi-line fields (purposes, notes, addresses); in a name they would print
# extra lines into the e-mails that show it ("Visitor: Sam Lee" followed by a forged "Company: …" line)
# and into every list that shows it on one line. At the ends they are trimmed (`strip_invisible`); VT
# and FF are control characters, refused everywhere.
_LINE_BREAKS = re.compile("[\t\n\r\x0b\x0c\x85\u2028\u2029]")
LINE_BREAKS_MESSAGE = "Enter this on one line, without line breaks or tabs."
LINE_BREAKS = FieldProblem(FieldCode.LINE_BREAKS, LINE_BREAKS_MESSAGE)


def _reject_line_breaks(value: str | None) -> str | None:
    if value is not None and _LINE_BREAKS.search(value):
        raise FieldValueError(LINE_BREAKS)
    return value


ONE_LINE = AfterValidator(_reject_line_breaks)

# A phone number is shown as typed and dialled as its digits (`tel:`), so it may hold nothing that would
# make the two differ: decimal digits (ASCII, Arabic-Indic, Extended Arabic-Indic), an optional leading
# "+", the usual separators (space, no-break spaces, parentheses, dot, slash, hyphen), at least three
# digits, and optionally an extension ("x 12", "ext. 12"). Letters, other scripts' digits (e.g. the
# mathematical bold ones, which a browser's `\d` drops), URLs and format characters are refused.
_PHONE_DIGIT = "0-9\u0660-\u0669\u06f0-\u06f9"
_PHONE_SEPARATOR = " \u00a0\u202f().\\/-"
_PHONE = re.compile(
    rf"\+?[{_PHONE_SEPARATOR}]*(?:[{_PHONE_DIGIT}][{_PHONE_SEPARATOR}]*){{3,}}"
    rf"(?:(?:x|ext\.?)[{_PHONE_SEPARATOR}]*[{_PHONE_DIGIT}]{{1,6}})?",
    re.IGNORECASE,
)
PHONE_MESSAGE = "Enter a phone number using digits, spaces and + ( ) - . / only."
INVALID_PHONE = FieldProblem(FieldCode.INVALID_PHONE, PHONE_MESSAGE)


def _valid_phone(value: str | None) -> str | None:
    if value is not None and not _PHONE.fullmatch(value):
        raise FieldValueError(INVALID_PHONE)
    return value


Name200 = Annotated[str, StringConstraints(min_length=1, max_length=200), TRIMMED, NO_BIDI_CONTROLS, ONE_LINE]
OptionalName200 = Annotated[
    Annotated[str, StringConstraints(max_length=200)] | None, BLANK_TO_NONE, NO_BIDI_CONTROLS, ONE_LINE
]
DepartmentName = Annotated[
    str, StringConstraints(min_length=1, max_length=120), TRIMMED, NO_BIDI_CONTROLS, ONE_LINE
]
# A department's Arabic name (B10-25): the rules of `DepartmentName`; blank input clears it (NULL).
OptionalDepartmentName = Annotated[
    Annotated[str, StringConstraints(max_length=120)] | None, BLANK_TO_NONE, NO_BIDI_CONTROLS, ONE_LINE
]
Phone = Annotated[
    Annotated[str, StringConstraints(max_length=40)] | None, BLANK_TO_NONE, AfterValidator(_valid_phone)
]
Reason300 = Annotated[str, StringConstraints(min_length=1, max_length=300), TRIMMED]
OptionalReason300 = Annotated[Annotated[str, StringConstraints(max_length=300)] | None, BLANK_TO_NONE]
Purpose = Annotated[str, StringConstraints(min_length=1, max_length=500), TRIMMED]
LoginEmail = Annotated[str, StringConstraints(min_length=1, max_length=320)]
SecretInput = Annotated[str, StringConstraints(min_length=1, max_length=1024)]
# Raw scanner/paste input: a hard size cap only. Generous next to the longest valid pass URL, so input a
# scanner garbled (or padded) still reaches the service and is answered as an invalid pass.
SCANNER_INPUT_MAX_LENGTH = 4096
ScannerInput = Annotated[str, StringConstraints(max_length=SCANNER_INPUT_MAX_LENGTH)]


class RequestModel(BaseModel):
    model_config = ConfigDict(extra="forbid", str_max_length=10_000)

    # Fields whose text the service classifies itself (scanner input), exempt from the
    # control-character rule below.
    unchecked_text_fields: ClassVar[frozenset[str]] = frozenset()

    # mode="after": Pydantic forbids before-validators on discriminator fields (`method` of the check-in
    # unions). Nested request models check their own fields; here only strings and lists of strings.
    @field_validator("*")
    @classmethod
    def _reject_control_characters(cls, value: object, info: ValidationInfo) -> object:
        if info.field_name in cls.unchecked_text_fields:
            return value
        items = value if isinstance(value, list | tuple) else (value,)
        if any(isinstance(item, str) and has_control_characters(item) for item in items):
            raise FieldValueError(CONTROL_CHARACTERS)
        return value


class ResponseModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)


InvitationStatus = Literal["NOT_SENT", "PENDING", "SENT", "FAILED"]
PassStatus = Literal["ACTIVE", "REVOKED", "EXPIRED", "NONE"]


class UserRef(ResponseModel):
    id: UUID
    full_name: str


class DepartmentRef(ResponseModel):
    """A department as other resources embed it. `name` is the default (English, or only) name and
    `name_ar` the Arabic one, null when it has none: an Arabic interface shows `name_ar` when it is set,
    else `name` (B10-25). In a visit both are the snapshots recorded on the visit (D-17)."""

    id: UUID
    name: str
    name_ar: str | None


class Message(ResponseModel):
    message: str


PAGE_SIZE_DEFAULT = 25
PAGE_SIZE_MAX = 100

PageNumber = Annotated[int, Field(ge=1, le=100_000)]
PageSize = Annotated[int, Field(ge=1, le=PAGE_SIZE_MAX)]


class Paginated[T](ResponseModel):
    items: list[T]
    page: int
    page_size: int
    total: int


# A new e-mail address (users, visitors): validated and stored lowercase.
EmailAddress = Annotated[
    str, StringConstraints(max_length=EMAIL_MAX_LENGTH), AfterValidator(validate_email_address)
]


def ordered_roles(values: Iterable[str | Role]) -> list[Role]:
    """Roles in canonical (enum) order without duplicates, for stable API output."""
    present = {Role(value) for value in values}
    return [role for role in Role if role in present]


# Optional e-mail: blank input means "no e-mail" (NULL).
OptionalEmailAddress = Annotated[EmailAddress | None, BeforeValidator(_blank_to_none)]


# Response role list: canonical order, duplicates collapsed.
RoleList = Annotated[list[Role], AfterValidator(ordered_roles)]


# ---- error envelope (contract §8) ---------------------------------------------------------------


class ErrorBody(ResponseModel):
    code: str  # one of the §8.2 codes; the full list is published as `error_codes` in the contract
    message: str
    details: dict[str, Any]


class ErrorEnvelope(ResponseModel):
    """Body of every non-2xx response."""

    error: ErrorBody
    request_id: str | None


# ---- query parameters ---------------------------------------------------------------------------

SEARCH_MAX_LENGTH = 100
MULTI_VALUE_MAX_LENGTH = 500


class QueryModel(RequestModel):
    """The query parameters of one endpoint. Unknown parameters are rejected like unknown body fields,
    so a renamed parameter fails loudly instead of being ignored."""


def _search_text(value: str | None) -> str | None:
    if value is None:
        return None
    # Checked before trimming: trimming white space would silently drop U+001C-U+001F.
    if has_control_characters(value):
        raise FieldValueError(CONTROL_CHARACTERS)
    return strip_invisible(value) or None


# Free-text search (`?q=`): trimmed like other free text; a query that shows nothing means "no filter".
SearchText = Annotated[
    Annotated[str, StringConstraints(max_length=SEARCH_MAX_LENGTH)] | None, AfterValidator(_search_text)
]


def _choices(values: Iterable[str]) -> str:
    quoted = [repr(value) for value in values]
    return quoted[0] if len(quoted) == 1 else f"{', '.join(quoted[:-1])} or {quoted[-1]}"


def comma_separated[E: StrEnum](enum_type: type[E]) -> BeforeValidator:
    """Parser of a multi-value enum filter, for `Annotated[list[Enum], comma_separated(Enum)]`: `a,b` and
    repeated parameters (`?x=a&x=b`) both give `[a, b]`; blank items and duplicates are dropped. An
    unknown value is a field error listing the allowed values (the input is not echoed)."""
    allowed = {member.value: member for member in enum_type}
    unknown = FieldProblem(
        FieldCode.INVALID_CHOICE, f"Choose one of: {_choices(allowed)}.", {"choices": tuple(allowed)}
    )
    too_long = FieldProblem(
        FieldCode.TOO_LONG,
        f"Enter at most {MULTI_VALUE_MAX_LENGTH} characters.",
        {"max": MULTI_VALUE_MAX_LENGTH},
    )

    def parse(value: object) -> object:
        raw: list[object] = list(value) if isinstance(value, list) else [value]
        texts = [item for item in raw if isinstance(item, str)]
        if len(texts) != len(raw):
            return value  # not query text: the list type reports it
        if sum(len(text) for text in texts) > MULTI_VALUE_MAX_LENGTH:
            raise FieldValueError(too_long)
        items = [part.strip() for text in texts for part in text.split(",")]
        if any(item and item not in allowed for item in items):
            raise FieldValueError(unknown)
        return list(dict.fromkeys(allowed[item] for item in items if item))

    return BeforeValidator(parse)


END_BEFORE_START = FieldProblem(FieldCode.END_BEFORE_START, "The end date must not be before the start date.")


class PageQuery(QueryModel):
    page: PageNumber = 1
    page_size: PageSize = PAGE_SIZE_DEFAULT


class DateRangeQuery(QueryModel):
    """An inclusive range of company-local dates; either end may be left open."""

    date_from: CompanyLocalDate | None = None
    date_to: CompanyLocalDate | None = None

    @field_validator("date_to")
    @classmethod
    def _not_before_start(cls, value: date | None, info: ValidationInfo) -> date | None:
        start = info.data.get("date_from")
        if value is not None and start is not None and value < start:
            raise FieldValueError(END_BEFORE_START)
        return value
