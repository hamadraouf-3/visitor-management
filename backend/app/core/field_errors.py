"""Machine codes of the field errors of a 422 VALIDATION_ERROR (Phase 10, B10-18).

`details.fields` maps each field path to a message written in English for people (contract §8.2). Since
Phase 10 the same response also carries `details.field_codes`, which maps the same paths to a stable code
and its parameters, so a client can show the problem in its own language without matching the English
wording:

    "details": {
      "fields":      {"purpose": "Enter at most 500 characters."},
      "field_codes": {"purpose": {"code": "too_long", "params": {"max": 500}}}
    }

Every field error has exactly one code from `FieldCode`, and `params` always holds exactly the parameters
`FIELD_CODE_PARAMS` lists for that code (`{}` when it lists none). Parameter values are numbers, text
(an `HH:MM` time, a `YYYY-MM-DD` date) or, for `choices`, a list of the allowed values as the API spells
them. The vocabulary is published in the contract snapshot (`field_error_codes`, with each code's
parameter names) and documented in docs/api.md §4.1.

Where the codes come from:
- Pydantic's own error types (`app.core.errors.field_problem`): one code per kind of problem, with the
  limit from the schema (`too_long` / `max`, `invalid_choice` / `choices`, ...);
- the schemas' own validators, which raise `FieldValueError(problem)`: a ValueError that carries its
  `FieldProblem`, so Pydantic's error keeps it in `ctx["error"]`;
- the services, which collect `FieldProblem`s in `FieldErrors` or raise `ValidationFailed` with them.

A message is written once, next to its rule, together with its code. The English message of a code may
vary with the context ("Email address is too long." and "Enter at most 200 characters." are both
`too_long`); the code and its parameters say everything a translation needs.
"""

from collections.abc import Mapping
from dataclasses import dataclass, field
from enum import StrEnum
from types import MappingProxyType

type ParamValue = int | float | str | tuple[str, ...]


class FieldCode(StrEnum):
    # ---- the shape of the input (Pydantic's types and the shared validators) ----------------------
    REQUIRED = "required"  # missing, empty after trimming, or null where null is not allowed
    NOT_ALLOWED = "not_allowed"  # a field the request does not have
    INVALID_JSON = "invalid_json"  # the body is not JSON (path `body`)
    INVALID = "invalid"  # any other invalid value
    INVALID_TEXT = "invalid_text"
    INVALID_FORMAT = "invalid_format"  # text that does not have the expected pattern
    INVALID_CHOICE = "invalid_choice"  # not one of `choices`
    INVALID_ID = "invalid_id"
    INVALID_INTEGER = "invalid_integer"
    INVALID_NUMBER = "invalid_number"
    INVALID_BOOLEAN = "invalid_boolean"
    INVALID_LIST = "invalid_list"
    INVALID_OBJECT = "invalid_object"
    INVALID_DATE = "invalid_date"  # not a `YYYY-MM-DD` date
    INVALID_DATETIME = "invalid_datetime"  # not an ISO 8601 date and time
    OFFSET_REQUIRED = "offset_required"  # a date and time without its UTC offset
    OFFSET_NOT_ALLOWED = "offset_not_allowed"
    TOO_SHORT = "too_short"  # fewer than `min` characters
    TOO_LONG = "too_long"  # more than `max` characters
    TOO_FEW_ITEMS = "too_few_items"  # fewer than `min` items
    TOO_MANY_ITEMS = "too_many_items"  # more than `max` items
    TOO_SMALL = "too_small"  # a number below `min`
    TOO_LARGE = "too_large"  # a number above `max`
    DATE_OUT_OF_RANGE = "date_out_of_range"  # a date outside `min` .. `max`
    DATETIME_OUT_OF_RANGE = "datetime_out_of_range"  # a date and time outside the dates `min` .. `max`
    OUT_OF_RANGE = "out_of_range"  # a date or number the server cannot work with (path `body`)
    UNSTORABLE_VALUE = "unstorable_value"  # a value the database cannot store (path `body`)
    CONTROL_CHARACTERS = "control_characters"
    BIDI_CONTROLS = "bidi_controls"  # text-direction control characters
    LINE_BREAKS = "line_breaks"  # line breaks or tabs in one-line text
    INVALID_EMAIL = "invalid_email"
    INVALID_DOMAIN = "invalid_domain"
    INVALID_PHONE = "invalid_phone"
    INVALID_TIMEZONE = "invalid_timezone"  # not a time zone of the list (IANA name)
    DUPLICATES = "duplicates"  # the same item twice in a list
    END_BEFORE_START = "end_before_start"  # a date range whose end date is before its start date
    NOT_FOUND = "not_found"  # an ID that names nothing the caller may use
    # ---- the rules of the product ------------------------------------------------------------------
    HOST_UNAVAILABLE = "host_unavailable"  # the host is inactive or cannot host visits
    HOST_MUST_BE_SELF = "host_must_be_self"  # only administrators invite on behalf of another host
    DEPARTMENT_INACTIVE = "department_inactive"
    VISITOR_REQUIRED = "visitor_required"  # neither an existing visitor nor new details
    VISITOR_BOTH = "visitor_both"  # an existing visitor and new details
    END_NOT_AFTER_START = "end_not_after_start"  # a visit's end time not after its start time
    VISIT_TOO_LONG = "visit_too_long"  # longer than `max_hours`
    END_IN_PAST = "end_in_past"
    START_IN_PAST = "start_in_past"
    TOO_FAR_AHEAD = "too_far_ahead"  # more than `max_days` ahead
    RANGE_TOO_LONG = "range_too_long"  # a report range of more than `max_days` days
    EXPECTED_END_IN_PAST = "expected_end_in_past"  # a walk-in's expected end not in the future
    CHECK_OUT_BEFORE_CHECK_IN = "check_out_before_check_in"
    CHECK_OUT_IN_FUTURE = "check_out_in_future"
    WALK_IN_EXPECTED_VISIT = "walk_in_expected_visit"  # lost pass: the visitor has a visit today
    WALK_IN_DURING_WINDOW = "walk_in_during_window"  # lost pass: a pass of the visitor is valid now
    WALK_IN_BEFORE_WINDOW = "walk_in_before_window"  # lost pass: a pass becomes valid at `time` today
    WALK_IN_NEEDS_RECORD = "walk_in_needs_record"  # lost pass: select the visitor's record
    TOO_MANY_REINVITATIONS = "too_many_reinvitations"  # `count` visits to re-invite, `limit` a day
    PASSWORD_IS_EMAIL = "password_is_email"
    PASSWORD_COMMON = "password_common"
    PASSWORD_GUESSABLE = "password_guessable"  # a common word with numbers or symbols added
    PASSWORD_PERSONAL = "password_personal"  # built from the account's name, address or company
    PASSWORD_UNCHANGED = "password_unchanged"  # the same as the current password
    # ---- a company's e-mail texts (Phase 11, B11-24) ------------------------------------------------
    UNKNOWN_PLACEHOLDER = "unknown_placeholder"  # `{name}` is not one of the e-mail's variables `allowed`
    PLACEHOLDER_REQUIRED = "placeholder_required"  # the text must contain the variable `{name}`
    INVALID_PLACEHOLDER = "invalid_placeholder"  # a brace that is not part of a `{variable}`
    MARKUP_NOT_ALLOWED = "markup_not_allowed"  # an HTML tag or character reference in plain text
    # B11-40: what bounds the size of an e-mail a company's texts can make.
    PLACEHOLDER_NOT_ALLOWED = "placeholder_not_allowed"  # `{name}` is a variable, but not of this text
    PLACEHOLDER_REPEATED = "placeholder_repeated"  # `{name}` appears more than `max` times in the text
    # ---- a company's brand (Phase 12, B12-6) ---------------------------------------------------------
    INVALID_COLOR = "invalid_color"  # not a colour written `#rrggbb` in lower case
    INVALID_IMAGE = "invalid_image"  # not a PNG image the product stores
    IMAGE_TOO_SMALL = "image_too_small"  # fewer than `min_width` x `min_height` pixels
    IMAGE_TOO_LARGE = "image_too_large"  # more than `max_width` x `max_height` pixels
    IMAGE_NOT_SQUARE = "image_not_square"  # an icon whose width is not its height
    # ---- the Visitor Journey's location registry (Phase 15, B15-5) ----------------------------------
    LOCATION_ARCHIVED = "location_archived"  # the building, floor or zone (or a parent of it) is archived


# The parameters each code carries (every other code carries none).
FIELD_CODE_PARAMS: Mapping[FieldCode, tuple[str, ...]] = MappingProxyType(
    {
        FieldCode.INVALID_CHOICE: ("choices",),
        FieldCode.TOO_SHORT: ("min",),
        FieldCode.TOO_LONG: ("max",),
        FieldCode.TOO_FEW_ITEMS: ("min",),
        FieldCode.TOO_MANY_ITEMS: ("max",),
        FieldCode.TOO_SMALL: ("min",),
        FieldCode.TOO_LARGE: ("max",),
        FieldCode.DATE_OUT_OF_RANGE: ("max", "min"),
        FieldCode.DATETIME_OUT_OF_RANGE: ("max", "min"),
        FieldCode.VISIT_TOO_LONG: ("max_hours",),
        FieldCode.TOO_FAR_AHEAD: ("max_days",),
        FieldCode.RANGE_TOO_LONG: ("max_days",),
        FieldCode.WALK_IN_BEFORE_WINDOW: ("time",),
        FieldCode.TOO_MANY_REINVITATIONS: ("count", "limit"),
        FieldCode.UNKNOWN_PLACEHOLDER: ("allowed", "name"),
        FieldCode.PLACEHOLDER_REQUIRED: ("name",),
        FieldCode.PLACEHOLDER_NOT_ALLOWED: ("name",),
        FieldCode.PLACEHOLDER_REPEATED: ("max", "name"),
        FieldCode.IMAGE_TOO_SMALL: ("min_height", "min_width"),
        FieldCode.IMAGE_TOO_LARGE: ("max_height", "max_width"),
    }
)


def code_params(code: FieldCode) -> tuple[str, ...]:
    """The parameter names of `code`, sorted (empty for most codes)."""
    return FIELD_CODE_PARAMS.get(code, ())


@dataclass(frozen=True, slots=True)
class FieldProblem:
    """One field error: its code, its English message and the code's parameters."""

    code: FieldCode
    message: str
    params: Mapping[str, ParamValue] = field(default_factory=dict)

    def __post_init__(self) -> None:
        expected = code_params(self.code)
        if tuple(sorted(self.params)) != expected:
            raise ValueError(f"field code {self.code.value!r} takes the parameters {expected}")

    def detail(self) -> dict[str, object]:
        """The `details.field_codes` entry: `{"code": ..., "params": {...}}` (lists for tuples)."""
        return {
            "code": self.code.value,
            "params": {
                name: list(value) if isinstance(value, tuple) else value
                for name, value in sorted(self.params.items())
            },
        }


class FieldValueError(ValueError):
    """What a schema validator raises: a ValueError (Pydantic reports it as `value_error` with this
    exception in `ctx["error"]`) that carries its `FieldProblem`. Its text is the problem's message."""

    def __init__(self, problem: FieldProblem) -> None:
        super().__init__(problem.message)
        self.problem = problem


def field_error_vocabulary() -> dict[str, list[str]]:
    """Every code with its parameter names, for the contract snapshot (`field_error_codes`)."""
    return {code.value: list(code_params(code)) for code in sorted(FieldCode, key=lambda code: code.value)}
