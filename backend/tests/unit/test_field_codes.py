"""Machine codes of 422 field errors (Phase 10, B10-18): `details.field_codes` beside `details.fields`.

Every field error of every request body and query model has a code from the published vocabulary
(`app.core.field_errors.FieldCode`), never the generic `invalid`, with exactly the parameters its code
declares. Schema validators raise `FieldValueError`, so a validator without a code cannot be written by
accident (checked on the source).
"""

import ast
import re
from collections.abc import Iterator
from pathlib import Path
from typing import Any, get_args

import pytest
from pydantic import BaseModel, TypeAdapter, ValidationError

from app import contract
from app.cli import AdminBootstrap
from app.core.errors import ValidationFailed, field_problem, validation_problems
from app.core.field_errors import (
    FIELD_CODE_PARAMS,
    FieldCode,
    FieldProblem,
    FieldValueError,
    code_params,
    field_error_vocabulary,
)
from app.schemas.audit import AuditLogQuery
from app.schemas.auth import PreferencesUpdate
from app.schemas.company import CompanySettingsUpdate
from app.schemas.reports import ReportSummaryQuery
from app.schemas.users import UserCreate, UserListQuery
from app.schemas.visitors import VisitorCreate
from app.schemas.visits import VisitCreate, VisitListQuery, WalkInCreate

APP = Path(__file__).resolve().parents[2] / "app"
REQUEST_MODELS: dict[str, Any] = {**contract.REQUESTS, **contract.QUERIES, "AdminBootstrap": AdminBootstrap}
HOST = "6f1c7f0e-8a0b-4d5e-9a57-2f3b1c9e4d21"
# Values no field accepts as they are, or accepts only some of: wrong types, empty and blank text, text
# that is too long, controls, direction controls, line breaks, unparsable dates, IDs and numbers.
HOSTILE: tuple[object, ...] = (
    None,
    7,
    -7,
    3.5,
    10**40,
    True,
    [],
    ["x"],
    [None],
    {},
    {"a": 1},
    "",
    "   ",
    "x" * 20_000,
    "a\x01b",
    "a‮b",
    "a\nb",
    "not a value",
    "2026-13-45",
    "2026-10-05T09:00:00",
    "0001-01-01T00:00:00+03:00",
    "00000000-0000-0000-0000-00000000000g",
    "ZZZ,AAA",
    "@@",
)


# ---- the vocabulary --------------------------------------------------------------------------------


def test_the_vocabulary_is_snake_case_and_published_with_each_code_s_parameters() -> None:
    assert all(re.fullmatch(r"[a-z]+(?:_[a-z]+)*", code.value) for code in FieldCode)
    assert set(FIELD_CODE_PARAMS) <= set(FieldCode)
    assert all(params == tuple(sorted(params)) for params in FIELD_CODE_PARAMS.values())
    vocabulary = field_error_vocabulary()
    assert vocabulary == {code.value: list(code_params(code)) for code in FieldCode}
    assert list(vocabulary) == sorted(vocabulary)
    assert contract.build()["field_error_codes"] == vocabulary


def test_a_problem_must_carry_exactly_its_code_s_parameters() -> None:
    assert FieldProblem(FieldCode.TOO_LONG, "Enter at most 5 characters.", {"max": 5}).detail() == {
        "code": "too_long",
        "params": {"max": 5},
    }
    choices = FieldProblem(
        FieldCode.INVALID_CHOICE, "Choose one of: 'ar' or 'en'.", {"choices": ("ar", "en")}
    )
    assert choices.detail() == {"code": "invalid_choice", "params": {"choices": ["ar", "en"]}}
    with pytest.raises(ValueError, match="too_long"):
        FieldProblem(FieldCode.TOO_LONG, "Too long.")
    with pytest.raises(ValueError, match="required"):
        FieldProblem(FieldCode.REQUIRED, "Required.", {"max": 1})


def test_validation_failed_gives_messages_and_codes_for_the_same_paths() -> None:
    error = ValidationFailed(
        {
            "name": FieldProblem(FieldCode.REQUIRED, "This field is required."),
            "visitor.email": FieldProblem(FieldCode.INVALID_EMAIL, "Enter a valid email address."),
        }
    )
    assert error.details == {
        "fields": {"name": "This field is required.", "visitor.email": "Enter a valid email address."},
        "field_codes": {
            "name": {"code": "required", "params": {}},
            "visitor.email": {"code": "invalid_email", "params": {}},
        },
    }


# ---- every request model ---------------------------------------------------------------------------


def _members(model: Any) -> Iterator[tuple[type[BaseModel], dict[str, Any]]]:
    """The models a request type validates with, each with the body that selects it (a discriminated union
    is entered through each tag)."""
    if isinstance(model, type) and issubclass(model, BaseModel):
        yield model, {}
        return
    union = get_args(model)[0]
    for member in get_args(union):
        tag = get_args(member.model_fields["method"].annotation)[0]
        yield member, {"method": tag}


def _problems(model: Any, body: dict[str, Any]) -> dict[str, FieldProblem]:
    try:
        TypeAdapter(model).validate_python(body)
    except ValidationError as exc:
        return validation_problems(exc.errors(), body)
    return {}


def _nested(member: type[BaseModel], field: str) -> type[BaseModel] | None:
    """The request model a field holds (`visitor` of a visit: `VisitorInput`), if any."""
    for candidate in (
        member.model_fields[field].annotation,
        *get_args(member.model_fields[field].annotation),
    ):
        if isinstance(candidate, type) and issubclass(candidate, BaseModel):
            return candidate
    return None


def _bodies(member: type[BaseModel], selector: dict[str, Any]) -> Iterator[dict[str, Any]]:
    """One body per field and hostile value, and the same inside a nested request model."""
    for field in member.model_fields:
        nested = _nested(member, field)
        for value in HOSTILE:
            yield {**selector, field: value, "unexpected_field": 1}
            if nested is not None:
                for inner in nested.model_fields:
                    yield {**selector, field: {inner: value, "unexpected_field": 1}}


@pytest.mark.parametrize("name", sorted(REQUEST_MODELS))
def test_every_field_error_of_every_request_model_has_a_specific_code(name: str) -> None:
    model = REQUEST_MODELS[name]
    seen: set[FieldCode] = set()
    for member, selector in _members(model):
        for body in _bodies(member, selector):
            for path, problem in _problems(model, body).items():
                assert problem.code is not FieldCode.INVALID, (name, body, path, problem)
                assert tuple(sorted(problem.params)) == code_params(problem.code), problem
                seen.add(problem.code)
    assert FieldCode.NOT_ALLOWED in seen


def _code(model: Any, body: dict[str, Any], path: str) -> dict[str, object]:
    return _problems(model, body)[path].detail()


VISIT = {
    "host_id": HOST,
    "purpose": "Review",
    "scheduled_start": "2026-10-05T09:00:00+03:00",
    "scheduled_end": "2026-10-05T10:00:00+03:00",
    "send_invitation": False,
}
WALK_IN = {"host_id": HOST, "purpose": "Delivery", "expected_end": "2026-10-05T11:00:00+03:00"}


@pytest.mark.parametrize(
    ("model", "body", "path", "expected"),
    [
        (VisitCreate, VISIT, "visitor", {"code": "visitor_required", "params": {}}),
        (
            VisitCreate,
            {**VISIT, "visitor_id": HOST, "visitor": {"full_name": "Dana"}},
            "visitor",
            {"code": "visitor_both", "params": {}},
        ),
        (
            WalkInCreate,
            {**WALK_IN, "visitor_id": HOST, "reason": "OTHER"},
            "reason_note",
            {"code": "required", "params": {}},
        ),
        (
            WalkInCreate,
            {**WALK_IN, "visitor_id": HOST, "reason": "LATE"},
            "reason",
            {
                "code": "invalid_choice",
                "params": {
                    "choices": [
                        "NO_INVITATION",
                        "EARLY_ARRIVAL",
                        "LATE_ARRIVAL",
                        "LOST_PASS",
                        "DELIVERY",
                        "OTHER",
                    ]
                },
            },
        ),
        (
            VisitCreate,
            {**VISIT, "visitor": {"full_name": "Dana‮", "email": "dana", "phone": "call me"}},
            "visitor.email",
            {"code": "invalid_email", "params": {}},
        ),
        (
            VisitCreate,
            {**VISIT, "visitor": {"full_name": "Dana", "phone": "call me"}},
            "visitor.phone",
            {"code": "invalid_phone", "params": {}},
        ),
        (
            VisitCreate,
            {**VISIT, "visitor": {"full_name": "Da‮na"}},
            "visitor.full_name",
            {"code": "bidi_controls", "params": {}},
        ),
        (
            VisitCreate,
            {**VISIT, "visitor": {"full_name": "Dana\nCompany: Evil"}},
            "visitor.full_name",
            {"code": "line_breaks", "params": {}},
        ),
        (
            VisitCreate,
            {**VISIT, "purpose": "x" * 501},
            "purpose",
            {"code": "too_long", "params": {"max": 500}},
        ),
        (VisitCreate, {**VISIT, "purpose": " ​ "}, "purpose", {"code": "required", "params": {}}),
        (VisitCreate, {**VISIT, "purpose": "a\x07"}, "purpose", {"code": "control_characters", "params": {}}),
        (
            VisitCreate,
            {**VISIT, "scheduled_end": "2026-10-05T10:00:00"},
            "scheduled_end",
            {"code": "offset_required", "params": {}},
        ),
        (
            VisitCreate,
            {**VISIT, "scheduled_end": "9999-12-31T23:00:00+00:00"},
            "scheduled_end",
            {"code": "datetime_out_of_range", "params": {"max": "9998-12-31", "min": "1900-01-01"}},
        ),
        (
            VisitListQuery,
            {"date_from": "1899-12-31"},
            "date_from",
            {"code": "date_out_of_range", "params": {"max": "9998-12-31", "min": "1900-01-01"}},
        ),
        (
            VisitListQuery,
            {"date_from": "2026-10-05", "date_to": "2026-10-04"},
            "date_to",
            {"code": "end_before_start", "params": {}},
        ),
        (
            VisitListQuery,
            {"status": "SCHEDULED,LOST"},
            "status",
            {
                "code": "invalid_choice",
                "params": {"choices": ["SCHEDULED", "CHECKED_IN", "CHECKED_OUT", "CANCELLED", "NO_SHOW"]},
            },
        ),
        (VisitListQuery, {"status": "S," * 300}, "status", {"code": "too_long", "params": {"max": 500}}),
        (VisitListQuery, {"page_size": 101}, "page_size", {"code": "too_large", "params": {"max": 100}}),
        (VisitListQuery, {"page": 0}, "page", {"code": "too_small", "params": {"min": 1}}),
        (
            ReportSummaryQuery,
            {"date_from": "2025-01-01", "date_to": "2026-01-02"},
            "date_to",
            {"code": "range_too_long", "params": {"max_days": 366}},
        ),
        (
            UserCreate,
            {"roles": ["EMPLOYEE", "EMPLOYEE"]},
            "roles",
            {"code": "duplicates", "params": {}},
        ),
        (UserCreate, {"roles": []}, "roles", {"code": "too_few_items", "params": {"min": 1}}),
        (
            UserListQuery,
            {"role": "ADMIN"},
            "role",
            {
                "code": "invalid_choice",
                "params": {"choices": ["SYSTEM_ADMIN", "EMPLOYEE", "RECEPTIONIST", "MANAGEMENT"]},
            },
        ),
        (
            VisitorCreate,
            {"full_name": "Dana", "email": "x@" + "a" * 400 + ".com"},
            "email",
            {"code": "too_long", "params": {"max": 320}},
        ),
        (
            CompanySettingsUpdate,
            {"email_domain": "not a domain"},
            "email_domain",
            {"code": "invalid_domain", "params": {}},
        ),
        (CompanySettingsUpdate, {"name": None}, "name", {"code": "required", "params": {}}),
        (
            CompanySettingsUpdate,
            {"pass_grace_before_minutes": -1},
            "pass_grace_before_minutes",
            {"code": "too_small", "params": {"min": 0}},
        ),
        (
            PreferencesUpdate,
            {"language": "fr"},
            "language",
            {"code": "invalid_choice", "params": {"choices": ["ar", "en"]}},
        ),
        (AuditLogQuery, {"action": "lower"}, "action", {"code": "invalid_format", "params": {}}),
    ],
)
def test_the_code_and_parameters_of_each_kind_of_problem(
    model: Any, body: dict[str, Any], path: str, expected: dict[str, object]
) -> None:
    assert _code(model, body, path) == expected


def test_the_messages_stay_as_they_were() -> None:
    """The codes are additive: `details.fields` keeps the English messages clients show today."""
    problems = _problems(VisitCreate, {**VISIT, "purpose": "x" * 501, "unexpected_field": 1})
    assert problems["purpose"].message == "Enter at most 500 characters."
    assert problems["unexpected_field"].message == "This field is not allowed."
    assert (
        _problems(PreferencesUpdate, {"language": "fr"})["language"].message == "Choose one of: 'ar' or 'en'."
    )


def test_an_uncoded_validator_falls_back_to_invalid_with_its_message() -> None:
    error = {"type": "value_error", "loc": ("x",), "msg": "Value error, Something is off.", "ctx": {}}
    assert field_problem(error) == FieldProblem(FieldCode.INVALID, "Something is off.")
    coded = {
        "type": "value_error",
        "ctx": {"error": FieldValueError(FieldProblem(FieldCode.INVALID_PHONE, "P"))},
    }
    assert field_problem(coded).code is FieldCode.INVALID_PHONE
    assert field_problem({"type": "some_future_type"}) == FieldProblem(
        FieldCode.INVALID, "Enter a valid value."
    )


def test_request_models_use_inclusive_bounds_only() -> None:
    """`gt` and `lt` would be reported as `too_small` / `too_large` with an exclusive limit, which the
    vocabulary does not say; every request model uses `ge` / `le`."""
    schema = contract.build()
    text = str({key: schema[key] for key in ("requests", "queries", "$defs")})
    assert "exclusiveMinimum" not in text and "exclusiveMaximum" not in text


# ---- validators raise coded errors (source check) ---------------------------------------------------

_CODED_RAISES = {"FieldValueError", "_field_error", "_invalid_email"}


@pytest.mark.parametrize(
    "path",
    sorted(
        str(path.relative_to(APP)) for path in [*(APP / "schemas").glob("*.py"), APP / "core" / "text.py"]
    ),
)
def test_every_validator_raises_a_coded_error(path: str) -> None:
    tree = ast.parse((APP / path).read_text(encoding="utf-8"))
    for node in ast.walk(tree):
        if isinstance(node, ast.Raise) and node.exc is not None:
            call = node.exc
            name = call.func.id if isinstance(call, ast.Call) and isinstance(call.func, ast.Name) else None
            assert name in _CODED_RAISES, f"{path}:{node.lineno} raises without a field code"
