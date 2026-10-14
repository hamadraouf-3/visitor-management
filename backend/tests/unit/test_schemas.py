"""Contract schemas (§8.1): shapes, nullability and request validation rules."""

import json
import uuid
from datetime import UTC, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import pytest
from pydantic import TypeAdapter, ValidationError

from app.core.errors import validation_fields, validation_problems
from app.core.text import validate_email_address
from app.schemas.common import DATETIME_OUT_OF_RANGE, SCANNER_INPUT_MAX_LENGTH, Paginated, strip_invisible
from app.schemas.company import CompanySettingsUpdate
from app.schemas.departments import Department, DepartmentCreate
from app.schemas.reception import ScanRequest, StaleCheckOutRequest
from app.schemas.users import User, UserUpdate
from app.schemas.visitors import VisitorCreate
from app.schemas.visits import (
    VISITOR_SOURCE_BOTH,
    VISITOR_SOURCE_MISSING,
    CheckInRequest,
    CheckOutRequest,
    Visit,
    VisitCancel,
    VisitCreate,
    VisitorSourceRequest,
    WalkInCreate,
)

HOST = str(uuid.uuid4())


def _visit_create(**overrides) -> dict:
    body = {
        "visitor": {"full_name": "Guest"},
        "host_id": HOST,
        "purpose": "Meeting",
        "scheduled_start": "2026-10-05T10:00:00+03:00",
        "scheduled_end": "2026-10-05T11:00:00+03:00",
        "send_invitation": False,
    }
    body.update(overrides)
    return body


def test_response_datetimes_are_utc_with_z() -> None:
    department = Department(
        id=uuid.uuid4(),
        name="IT",
        name_ar="تقنية المعلومات",
        is_active=True,
        created_at=datetime(2026, 10, 5, 12, 0, tzinfo=timezone(timedelta(hours=3))),
        updated_at=datetime(2026, 10, 5, 9, 0, tzinfo=UTC),
    )
    dumped = department.model_dump(mode="json")
    assert dumped["created_at"] == "2026-10-05T09:00:00Z"
    assert dumped["updated_at"] == "2026-10-05T09:00:00Z"


@pytest.mark.parametrize(
    ("instant", "rendered"),
    [
        (
            datetime(2026, 10, 5, 12, 0, 0, 123456, tzinfo=timezone(timedelta(hours=3))),
            "2026-10-05T09:00:00.123456Z",
        ),
        (datetime(2026, 10, 5, 9, 0, 0, 120000, tzinfo=UTC), "2026-10-05T09:00:00.120000Z"),
        (datetime(2026, 10, 5, 9, 0, tzinfo=ZoneInfo("UTC")), "2026-10-05T09:00:00Z"),
        (datetime(2026, 10, 5, 4, 0, tzinfo=ZoneInfo("America/New_York")), "2026-10-05T08:00:00Z"),
    ],
)
def test_response_instants_render_as_utc_on_the_wire(instant: datetime, rendered: str) -> None:
    """Re-audit round 1: instants are converted to UTC when the model is built and rendered by Pydantic
    (no serialiser function per instant). The wire format is what it was: UTC with `Z`, microseconds
    when there are any, in `model_dump_json` (what the API sends) as in `model_dump(mode="json")`."""
    department = Department(
        id=uuid.uuid4(), name="IT", name_ar=None, is_active=True, created_at=instant, updated_at=instant
    )
    assert department.created_at.tzinfo is UTC and department.created_at == instant
    assert json.loads(department.model_dump_json())["created_at"] == rendered
    assert department.model_dump(mode="json")["updated_at"] == rendered


def test_request_datetimes_must_be_aware_and_become_utc() -> None:
    created = VisitCreate.model_validate(_visit_create())
    assert created.scheduled_start == datetime(2026, 10, 5, 7, 0, tzinfo=UTC)
    with pytest.raises(ValidationError) as caught:
        VisitCreate.model_validate(_visit_create(scheduled_end="2026-10-05T11:00:00"))
    assert caught.value.errors()[0]["loc"] == ("scheduled_end",)


@pytest.mark.parametrize(
    "value",
    [
        "0001-01-01T00:00:00+03:00",  # year 0 in UTC: converting it overflows
        "9999-12-31T23:59:59-05:00",  # year 10000 in UTC
        "9999-12-31T00:00:00+00:00",  # representable, but a day or a grace period added would overflow
        "1899-12-31T23:59:59+00:00",
    ],
)
def test_request_datetimes_outside_the_supported_range_are_field_errors(value: str) -> None:
    with pytest.raises(ValidationError) as caught:
        VisitCreate.model_validate(_visit_create(scheduled_end=value))
    assert validation_fields(caught.value.errors()) == {"scheduled_end": DATETIME_OUT_OF_RANGE}


def test_request_datetimes_at_the_ends_of_the_supported_range_are_accepted() -> None:
    for value, expected in (
        ("1900-01-01T00:00:00Z", datetime(1900, 1, 1, tzinfo=UTC)),
        ("9998-12-31T23:59:59+00:00", datetime(9998, 12, 31, 23, 59, 59, tzinfo=UTC)),
    ):
        assert VisitCreate.model_validate(_visit_create(scheduled_end=value)).scheduled_end == expected


def test_visit_create_requires_exactly_one_visitor_source() -> None:
    for body, message in (
        (_visit_create(visitor=None), VISITOR_SOURCE_MISSING),
        (_visit_create(visitor_id=str(uuid.uuid4())), VISITOR_SOURCE_BOTH),
    ):
        with pytest.raises(ValidationError) as caught:
            VisitCreate.model_validate({k: v for k, v in body.items() if v is not None})
        [error] = caught.value.errors()
        assert error["loc"] == ("visitor",)
        assert validation_fields(caught.value.errors()) == {"visitor": message.message}
        assert validation_problems(caught.value.errors()) == {"visitor": message}
    VisitCreate.model_validate({**_visit_create(visitor=None), "visitor_id": str(uuid.uuid4())})


def test_a_malformed_visitor_id_is_reported_on_its_own() -> None:
    # The source rule runs only when every field is valid, so it adds no second, misleading error.
    with pytest.raises(ValidationError) as caught:
        VisitCreate.model_validate({**_visit_create(visitor=None), "visitor_id": "not-a-uuid"})
    assert validation_fields(caught.value.errors()) == {"visitor_id": "Enter a valid ID."}


def test_blank_optional_email_becomes_none_and_bad_email_fails() -> None:
    created = VisitCreate.model_validate(_visit_create(visitor={"full_name": "Guest", "email": "  "}))
    assert created.visitor is not None and created.visitor.email is None
    with pytest.raises(ValidationError):
        VisitCreate.model_validate(_visit_create(visitor={"full_name": "Guest", "email": "nope"}))


def test_check_in_and_out_are_discriminated_unions() -> None:
    check_in = TypeAdapter(CheckInRequest)
    assert check_in.validate_python({"method": "MANUAL"}).method == "MANUAL"
    with pytest.raises(ValidationError):
        check_in.validate_python({"method": "OVERRIDE"})  # reason required
    with pytest.raises(ValidationError):
        check_in.validate_python({"method": "WALK_IN"})
    check_out = TypeAdapter(CheckOutRequest)
    corrected = check_out.validate_python(
        {"method": "CORRECTED", "check_out_at": "2026-10-05T18:00:00+03:00", "note": "Left without scanning"}
    )
    assert corrected.check_out_at.tzinfo is UTC


def test_walk_in_other_requires_note() -> None:
    base = {
        "visitor_id": str(uuid.uuid4()),
        "host_id": HOST,
        "purpose": "Delivery",
        "expected_end": "2026-10-05T12:00:00Z",
    }
    WalkInCreate.model_validate({**base, "reason": "DELIVERY"})
    with pytest.raises(ValidationError):
        WalkInCreate.model_validate({**base, "reason": "OTHER"})
    WalkInCreate.model_validate({**base, "reason": "OTHER", "reason_note": "Courier"})


def test_visit_exposes_pass_key() -> None:
    schema = Visit.model_json_schema(by_alias=True, mode="serialization")
    assert "pass" in schema["properties"]
    assert "pass_" not in schema["properties"]


def test_user_cancelled_visits_is_omitted_unless_set() -> None:
    values = {
        "id": uuid.uuid4(),
        "full_name": "A",
        "email": "a@example.com",
        "phone": None,
        "roles": ["MANAGEMENT", "EMPLOYEE"],
        "department": None,
        "is_active": True,
        "must_change_password": False,
        "last_login_at": None,
        "created_at": datetime(2026, 1, 1, tzinfo=UTC),
        "updated_at": datetime(2026, 1, 1, tzinfo=UTC),
    }
    dumped = User.model_validate(values).model_dump(mode="json")
    assert "cancelled_visits" not in dumped
    assert dumped["roles"] == ["EMPLOYEE", "MANAGEMENT"]
    assert dumped["phone"] is None and dumped["last_login_at"] is None
    assert (
        User.model_validate({**values, "cancelled_visits": 3}).model_dump(mode="json")["cancelled_visits"]
        == 3
    )


def test_user_update_distinguishes_null_from_missing() -> None:
    assert UserUpdate.model_validate({}).model_fields_set == set()
    assert UserUpdate.model_validate({"department_id": None}).model_fields_set == {"department_id"}
    with pytest.raises(ValidationError):
        UserUpdate.model_validate({"full_name": None})


def test_paginated_shape() -> None:
    page = Paginated[Department](items=[], page=1, page_size=25, total=0)
    assert page.model_dump() == {"items": [], "page": 1, "page_size": 25, "total": 0}


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("Person@Example.COM", "person@example.com"),
        ("admin@demo.local", "admin@demo.local"),
        ("x@fail.test", "x@fail.test"),
        (" spaced@example.com ", "spaced@example.com"),
    ],
)
def test_email_validation_accepts(value: str, expected: str) -> None:
    assert validate_email_address(value) == expected


@pytest.mark.parametrize(
    "value",
    [
        "plain",
        "a@b",
        "a@localhost",
        "a@x.invalid",
        "a b@example.com",
        "a@@example.com",
        # RFC 2047 §5: no encoded word in an address (a mail library would decode it in the To header).
        "=?utf-8?q?bcc=3a_x=40evil.test=0d=0a?=@example.com",
        "dana=?x@example.com",
        "＝？utf-8？q？x？＝@example.com",  # noqa: RUF001 - fullwidth, "=?" after NFKC
    ],
)
def test_email_validation_rejects(value: str) -> None:
    with pytest.raises(ValueError, match="valid email"):
        validate_email_address(value)


@pytest.mark.parametrize(
    ("model", "field"),
    [
        ("app.schemas.departments:DepartmentUpdate", "name"),
        ("app.schemas.departments:DepartmentUpdate", "is_active"),
        ("app.schemas.company:CompanySettingsUpdate", "timezone"),
        ("app.schemas.company:CompanySettingsUpdate", "pass_grace_before_minutes"),
        ("app.schemas.visitors:VisitorUpdate", "full_name"),
        ("app.schemas.visits:VisitUpdate", "scheduled_start"),
        ("app.schemas.users:UserUpdate", "roles"),
    ],
)
def test_patch_models_reject_explicit_null_but_allow_omission(model: str, field: str) -> None:
    module_name, class_name = model.split(":")
    cls = getattr(__import__(module_name, fromlist=[class_name]), class_name)
    assert cls.model_validate({}).model_fields_set == set()
    with pytest.raises(ValidationError) as caught:
        cls.model_validate({field: None})
    assert caught.value.errors()[0]["loc"] == (field,)
    assert "cannot be null" in caught.value.errors()[0]["msg"]


@pytest.mark.parametrize("value", ["a\x00b", "tab\tok\x07bell", "\x1b[31m", "del\x7f"])
def test_request_strings_reject_control_characters(value: str) -> None:
    with pytest.raises(ValidationError) as caught:
        VisitCreate.model_validate(_visit_create(purpose=value))
    assert caught.value.errors()[0]["loc"] == ("purpose",)
    with pytest.raises(ValidationError):
        VisitCreate.model_validate(_visit_create(visitor={"full_name": value}))


def test_multi_line_text_is_allowed() -> None:
    created = VisitCreate.model_validate(_visit_create(purpose="Line one\r\nLine two\tindented"))
    assert created.purpose == "Line one\r\nLine two\tindented"
    check_in = TypeAdapter(CheckInRequest).validate_python({"method": "OVERRIDE", "reason": "Late\nbus"})
    assert check_in.method == "OVERRIDE"


# ---- scanner input reaches the service (contract §6 row 1: PASS_INVALID, never 422) -------------

SCANNER_GARBAGE = [
    "",
    " ",
    "\t",
    "Xo3_vK9-aQ2rT7mN4bL8cY1zW6eH5jP0sD-gF_uIk2A\x1d",  # trailing GS from a handheld scanner
    "\x00\x01\x7f",
    "https://vms.example.com/pass#" + "T" * 3000,  # longer than any valid pass, below the hard cap
    "x" * SCANNER_INPUT_MAX_LENGTH,
    "Hello, reception!",
]


@pytest.mark.parametrize("value", SCANNER_GARBAGE)
def test_scan_request_accepts_any_text_below_the_cap(value: str) -> None:
    assert ScanRequest.model_validate({"token": value}).token == value  # unchanged, not even trimmed


@pytest.mark.parametrize("value", SCANNER_GARBAGE)
def test_qr_check_in_and_out_accept_any_pass_token_text(value: str) -> None:
    check_in = TypeAdapter(CheckInRequest).validate_python({"method": "QR", "pass_token": value})
    check_out = TypeAdapter(CheckOutRequest).validate_python({"method": "QR", "pass_token": value})
    assert check_in.pass_token == value and check_out.pass_token == value


def test_scanner_input_keeps_a_hard_size_cap_and_its_shape() -> None:
    with pytest.raises(ValidationError):
        ScanRequest.model_validate({"token": "x" * (SCANNER_INPUT_MAX_LENGTH + 1)})
    with pytest.raises(ValidationError):
        ScanRequest.model_validate({"token": 12345})
    with pytest.raises(ValidationError):
        ScanRequest.model_validate({"token": "ok", "extra": 1})
    with pytest.raises(ValidationError):
        TypeAdapter(CheckInRequest).validate_python({"method": "QR"})


def test_only_scanner_fields_skip_the_control_character_rule() -> None:
    with pytest.raises(ValidationError):  # the reason next to it is still checked
        TypeAdapter(CheckInRequest).validate_python({"method": "OVERRIDE", "reason": "late\x00"})
    with pytest.raises(ValidationError):
        CompanySettingsUpdate.model_validate({"name": "Ac\x1dme"})


def test_visit_create_and_walk_in_share_the_visitor_source_rule() -> None:
    assert issubclass(VisitCreate, VisitorSourceRequest) and issubclass(WalkInCreate, VisitorSourceRequest)
    assert list(VisitCreate.model_fields)[:2] == ["visitor_id", "visitor"]
    assert list(WalkInCreate.model_fields)[:2] == ["visitor_id", "visitor"]
    walk_in = {
        "host_id": HOST,
        "purpose": "Delivery",
        "expected_end": "2026-10-05T11:00:00+03:00",
        "reason": "DELIVERY",
    }
    both = {**walk_in, "visitor_id": HOST, "visitor": {"full_name": "Guest"}}
    for body, message in ((walk_in, VISITOR_SOURCE_MISSING), (both, VISITOR_SOURCE_BOTH)):
        with pytest.raises(ValidationError) as caught:
            WalkInCreate.model_validate(body)
        assert validation_problems(caught.value.errors()) == {"visitor": message}
    assert WalkInCreate.model_validate({**walk_in, "visitor_id": HOST}).visitor is None


# ---- free text must show something (invisible characters, L-BE-1) ------------------------------

# Values a person sees as empty: format characters (zero width space, word joiner, byte order mark,
# bidirectional marks), Hangul fillers, the blank braille cell, a stray variation selector or tags, mixed
# with white space.
INVISIBLE_ONLY = [
    "\N{ZERO WIDTH SPACE}",
    "\N{ZERO WIDTH NO-BREAK SPACE}",
    "\N{WORD JOINER}",
    "\N{SOFT HYPHEN}",
    "\N{ZERO WIDTH JOINER}\N{ZERO WIDTH NON-JOINER}",
    "\N{LEFT-TO-RIGHT MARK}\N{RIGHT-TO-LEFT MARK}\N{LEFT-TO-RIGHT EMBEDDING}\N{POP DIRECTIONAL FORMATTING}"
    "\N{LEFT-TO-RIGHT ISOLATE}\N{POP DIRECTIONAL ISOLATE}",
    "\N{HANGUL FILLER}",
    "\N{HALFWIDTH HANGUL FILLER}",
    "\N{HANGUL CHOSEONG FILLER}\N{HANGUL JUNGSEONG FILLER}",
    "\N{BRAILLE PATTERN BLANK}",
    "\N{VARIATION SELECTOR-16}",
    "\N{TAG SPACE}\N{CANCEL TAG}",
    " \N{ZERO WIDTH SPACE}\N{NO-BREAK SPACE}\N{ZERO WIDTH NO-BREAK SPACE}\N{IDEOGRAPHIC SPACE} ",
]
WALK_IN = {
    "visitor": {"full_name": "Guest"},
    "host_id": HOST,
    "purpose": "Delivery",
    "expected_end": "2026-10-05T12:00:00Z",
    "reason": "DELIVERY",
}


def _required_error(validate, body: dict) -> dict[str, str]:
    with pytest.raises(ValidationError) as caught:
        validate(body)
    # Located in the body, as the API reports them (the union tag `OVERRIDE` removed).
    errors = [{**error, "loc": ("body", *error["loc"])} for error in caught.value.errors()]
    return validation_fields(errors, body)


@pytest.mark.parametrize("blank", INVISIBLE_ONLY)
def test_required_free_text_must_show_something(blank: str) -> None:
    required = "This field is required."
    check_in = TypeAdapter(CheckInRequest).validate_python
    check_out = TypeAdapter(CheckOutRequest).validate_python
    corrected = {"method": "CORRECTED", "check_out_at": "2026-10-05T18:00:00+03:00", "note": blank}
    assert _required_error(check_in, {"method": "OVERRIDE", "reason": blank}) == {"reason": required}
    assert _required_error(check_out, corrected) == {"note": required}
    assert _required_error(StaleCheckOutRequest.model_validate, {"reason": blank}) == {"reason": required}
    assert _required_error(
        WalkInCreate.model_validate, {**WALK_IN, "visitor": {"full_name": blank}, "purpose": blank}
    ) == {"visitor.full_name": required, "purpose": required}
    assert _required_error(
        WalkInCreate.model_validate, {**WALK_IN, "reason": "OTHER", "reason_note": blank}
    ) == {"reason_note": "Describe the reason for this walk-in."}
    assert _required_error(VisitCreate.model_validate, _visit_create(visitor={"full_name": blank})) == {
        "visitor.full_name": required
    }
    assert _required_error(VisitorCreate.model_validate, {"full_name": blank}) == {"full_name": required}
    assert _required_error(UserUpdate.model_validate, {"full_name": blank}) == {"full_name": required}
    assert _required_error(DepartmentCreate.model_validate, {"name": blank}) == {"name": required}
    assert _required_error(CompanySettingsUpdate.model_validate, {"name": blank}) == {"name": required}


@pytest.mark.parametrize("blank", INVISIBLE_ONLY)
def test_optional_free_text_that_shows_nothing_is_none(blank: str) -> None:
    walk_in = WalkInCreate.model_validate(
        {
            **WALK_IN,
            "visitor": {"full_name": "Guest", "phone": blank, "company_name": blank},
            "reason_note": blank,
        }
    )
    assert walk_in.reason_note is None
    assert walk_in.visitor is not None
    assert (walk_in.visitor.phone, walk_in.visitor.company_name) == (None, None)
    assert VisitCancel.model_validate({"reason": blank}).reason is None
    assert VisitorCreate.model_validate({"full_name": "Guest", "email": blank}).email is None


def test_invisible_characters_are_trimmed_only_at_the_ends() -> None:
    zwsp, word_joiner, bom = "\N{ZERO WIDTH SPACE}", "\N{WORD JOINER}", "\N{ZERO WIDTH NO-BREAK SPACE}"
    override = TypeAdapter(CheckInRequest).validate_python(
        {"method": "OVERRIDE", "reason": f"{bom}{zwsp}Late bus{zwsp}{word_joiner} "}
    )
    assert override.method == "OVERRIDE" and override.reason == "Late bus"
    # Inside a value they are kept: ZWNJ shapes Persian words ("mikhaham"), ZWJ and the emoji presentation
    # selector build emoji, and a flag's tag sequence follows its base character.
    persian = (
        "\N{ARABIC LETTER MEEM}\N{ARABIC LETTER FARSI YEH}\N{ZERO WIDTH NON-JOINER}\N{ARABIC LETTER KHAH}"
    )
    family = "\N{MAN}\N{ZERO WIDTH JOINER}\N{WOMAN}\N{ZERO WIDTH JOINER}\N{GIRL}"
    heart = "\N{HEAVY BLACK HEART}\N{VARIATION SELECTOR-16}"
    flag = "\N{WAVING BLACK FLAG}\N{TAG LATIN SMALL LETTER G}\N{TAG LATIN SMALL LETTER B}\N{CANCEL TAG}"
    for text in (persian, family, f"Thanks {heart}", f"Team {flag}"):
        assert StaleCheckOutRequest.model_validate({"reason": f"{zwsp}{text}{zwsp}"}).reason == text
    sara = "\N{ARABIC LETTER SEEN}\N{ARABIC LETTER ALEF}\N{ARABIC LETTER REH}\N{ARABIC LETTER TEH MARBUTA}"
    isolated = f"\N{RIGHT-TO-LEFT ISOLATE}{sara}\N{POP DIRECTIONAL ISOLATE}\N{NO-BREAK SPACE}"
    assert VisitorCreate.model_validate({"full_name": isolated}).full_name == sara
    # A format character that is visible stays (it marks the number after it).
    assert strip_invisible("\N{ARABIC NUMBER SIGN}123") == "\N{ARABIC NUMBER SIGN}123"


# ---- what is shown is what is stored (SEC-10) -----------------------------------------------------

RLO, PDF = "\N{RIGHT-TO-LEFT OVERRIDE}", "\N{POP DIRECTIONAL FORMATTING}"
RLI, PDI = "\N{RIGHT-TO-LEFT ISOLATE}", "\N{POP DIRECTIONAL ISOLATE}"


@pytest.mark.parametrize(
    ("model", "body", "field"),
    [
        (VisitorCreate, {"full_name": f"A{RLO}htims ecil"}, "full_name"),
        (VisitorCreate, {"full_name": "Guest", "company_name": f"Acme {RLI}x{PDI} Ltd"}, "company_name"),
        (VisitorCreate, {"full_name": "Guest", "phone": f"+962 79 {RLO}2001 005"}, "phone"),
        (DepartmentCreate, {"name": f"Ops{PDF}x"}, "name"),
        (UserUpdate, {"full_name": "Omar \N{LEFT-TO-RIGHT EMBEDDING}K"}, "full_name"),
        (CompanySettingsUpdate, {"name": "Demo \N{LEFT-TO-RIGHT OVERRIDE}Co"}, "name"),
    ],
)
def test_names_and_phones_refuse_interior_direction_controls(model: type, body: dict, field: str) -> None:
    with pytest.raises(ValidationError) as caught:
        model.model_validate(body)
    assert validation_fields(caught.value.errors()) == {
        field: (
            "Enter a phone number using digits, spaces and + ( ) - . / only."
            if field == "phone"
            else "Remove text-direction control characters."
        )
    }


def test_direction_marks_and_edge_isolates_stay_allowed_in_names() -> None:
    sara = "\N{ARABIC LETTER SEEN}\N{ARABIC LETTER ALEF}\N{ARABIC LETTER REH}\N{ARABIC LETTER TEH MARBUTA}"
    with_marks = f"{sara} \N{RIGHT-TO-LEFT MARK}(Sara)\N{LEFT-TO-RIGHT MARK} Haddad"
    assert VisitorCreate.model_validate({"full_name": with_marks}).full_name == with_marks
    assert VisitorCreate.model_validate({"full_name": f"{RLI}{sara}{PDI}"}).full_name == sara


@pytest.mark.parametrize(
    "phone",
    [
        "+962 79 500 1002",
        "079 123 4567",
        "+1 (555) 010-0199",
        "+962791234567",
        "079/5551234",
        "+44 20 7946 0958 x123",
        "0791234567 ext. 12",
        "+962\N{NO-BREAK SPACE}79\N{NARROW NO-BREAK SPACE}111 2222",
        "".join(chr(0x0660 + int(d)) for d in "0791234567"),  # Arabic-Indic digits
        "".join(chr(0x06F0 + int(d)) for d in "0912345678"),  # Extended Arabic-Indic (Persian)
        "101",
    ],
)
def test_phone_numbers_in_common_formats_are_accepted(phone: str) -> None:
    assert VisitorCreate.model_validate({"full_name": "Guest", "phone": phone}).phone == phone


@pytest.mark.parametrize(
    "phone",
    [
        f"+962 79 {RLO}2001 005",
        f"+962 79 {RLI}2001{PDI} 005",
        "+962 79 1\N{ZERO WIDTH SPACE}23",
        "javascript:alert(1)//+962",
        "1-800-FLOWERS",
        "\N{MATHEMATICAL BOLD DIGIT FIVE}" * 4,  # a browser's \d drops these from the tel: link
        "n/a",
        "12",
        "++962 79 111",
        "+962 79 555 1234 ext",
    ],
)
def test_phone_numbers_that_would_dial_differently_are_refused(phone: str) -> None:
    for model in (VisitorCreate, UserUpdate):
        body = {"full_name": "Guest", "phone": phone}
        with pytest.raises(ValidationError) as caught:
            model.model_validate(body)
        assert validation_fields(caught.value.errors()) == {
            "phone": "Enter a phone number using digits, spaces and + ( ) - . / only."
        }
