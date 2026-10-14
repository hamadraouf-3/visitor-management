import inspect
import logging
from datetime import date
from typing import Annotated, Literal
from uuid import UUID

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import (
    AwareDatetime,
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    ValidationError,
    field_validator,
)
from sqlalchemy.exc import DataError

from app.core import errors
from app.core.errors import AppError, register_exception_handlers, validation_fields
from app.core.field_errors import FieldCode, FieldProblem
from app.models import Role
from app.schemas.visits import CheckInRequest, CheckOutRequest

# Contract §8.2 (and §6 / §7.3 messages): code -> (status, message)
CONTRACT = {
    "NOT_AUTHENTICATED": (401, "Please sign in."),
    "INVALID_CREDENTIALS": (401, "Invalid email or password."),
    "FORBIDDEN": (403, "You do not have permission to perform this action."),
    "CSRF_FAILED": (403, "Your session could not be verified. Please refresh the page and try again."),
    "PASSWORD_CHANGE_REQUIRED": (403, "You must change your password before continuing."),
    "INVALID_RESET_TOKEN": (400, "This password reset link is invalid or has expired."),
    "INVALID_CURRENT_PASSWORD": (400, "Your current password is incorrect."),
    "NOT_FOUND": (404, "The requested item was not found."),
    "CONFLICT": (409, None),
    "USER_EMAIL_UNAVAILABLE": (409, "This email address cannot be used."),
    "LAST_ADMIN": (409, "The company must keep at least one active administrator."),
    "SELF_MODIFICATION": (409, "You cannot remove your own administrator access or deactivate yourself."),
    "VISITOR_EXISTS": (409, "A visitor with this email already exists."),
    "INVALID_STATE_TRANSITION": (409, "This action is not allowed for the visit's current status."),
    "VISIT_NOT_EDITABLE": (409, "Only scheduled visits can be changed."),
    "VISIT_ALREADY_CHECKED_IN": (409, "This visitor is already checked in."),
    "VISIT_NOT_CHECKED_IN": (409, "This visitor is not checked in."),
    "VISITOR_ALREADY_INSIDE": (409, "This visitor is already checked in on another visit."),
    "VISIT_CANCELLED": (409, "This visit has been cancelled."),
    "VISIT_COMPLETED": (409, "This visit has already been completed."),
    "HOST_INACTIVE": (
        409,
        "The host for this visit is no longer active. Register the visitor as a walk-in with a current host.",
    ),
    "PASS_NOT_YET_VALID": (409, "This visitor pass is not valid yet."),
    "PASS_EXPIRED": (410, "This visitor pass has expired."),
    "PASS_REVOKED": (
        410,
        "This visitor pass has been replaced. Ask the visitor for their latest invitation, "
        "or verify their ID and check in manually.",
    ),
    "PASS_INVALID": (404, "Invalid visitor pass."),
    "VISITOR_EMAIL_REQUIRED": (409, "The visitor needs an email address to receive an invitation."),
    "WALK_INS_DISABLED": (409, "Walk-in registration is disabled for this company."),
    "OVERRIDE_NOT_ALLOWED": (409, "This visit cannot be checked in with an override."),
    "VALIDATION_ERROR": (422, "Please correct the highlighted fields."),
    "PAYLOAD_TOO_LARGE": (413, "The request is too large."),
    "RATE_LIMITED": (429, "Too many requests. Please wait and try again."),
    "INVITATION_LIMIT": (429, "Invitation limit reached. Please try again later."),
    "SERVICE_BUSY": (503, "The service is busy. Please try again."),
    "INTERNAL_ERROR": (500, "Something went wrong. Please try again."),
}


def _error_classes() -> dict[str, type[AppError]]:
    classes = {}
    for _name, value in inspect.getmembers(errors, inspect.isclass):
        if issubclass(value, AppError) and value is not AppError and not value.__name__.startswith("_"):
            classes.setdefault(value.code, value)
    return classes


def test_every_contract_code_has_an_error_class() -> None:
    classes = _error_classes()
    for code, (status, message) in CONTRACT.items():
        assert code in classes, code
        assert classes[code].status_code == status, code
        if message is not None:
            assert classes[code].default_message == message, code


def _instance(error_class: type[AppError]) -> AppError:
    if error_class is errors.Conflict:
        return errors.Conflict("name")
    if error_class is errors.ValidationFailed:
        return errors.ValidationFailed({"field": FieldProblem(FieldCode.REQUIRED, "Required.")})
    if error_class in (errors.RateLimited, errors.InvitationLimit):
        return error_class(retry_after=7, policy="p")
    return error_class()


@pytest.fixture
def app() -> FastAPI:
    app = FastAPI()
    register_exception_handlers(app)
    recorded = []
    app.state.security_event_sink = lambda request, event: recorded.append(event)
    app.state.recorded = recorded

    @app.get("/raise/{code}")
    def raise_error(code: str) -> None:
        raise _instance(_error_classes()[code])

    class Body(BaseModel):
        email: str
        age: int

    @app.post("/validate")
    def validate(body: Body) -> None:
        return None

    @app.post("/items/{item_id}")
    def item(item_id: UUID, body: Body) -> None:
        return None

    @app.get("/unstorable")
    def unstorable() -> None:
        # What psycopg raises for a NUL character in a text parameter.
        raise DataError(
            "INSERT ...", {}, ValueError("PostgreSQL text fields cannot contain NUL (0x00) bytes")
        )

    @app.get("/overflow")
    def overflow() -> None:
        # What date arithmetic on an extreme client value raises (`date.max + timedelta(days=1)`).
        raise OverflowError("date value out of range")

    return app


@pytest.mark.parametrize("code", sorted(CONTRACT))
def test_envelope_for_each_code(app: FastAPI, code: str) -> None:
    response = TestClient(app).get(f"/raise/{code}")
    status, message = CONTRACT[code]
    assert response.status_code == status
    body = response.json()
    assert set(body) == {"error", "request_id"}
    assert body["error"]["code"] == code
    if message is not None:
        assert body["error"]["message"] == message
    assert isinstance(body["error"]["details"], dict)


def test_throttled_errors_carry_retry_after(app: FastAPI) -> None:
    response = TestClient(app).get("/raise/RATE_LIMITED")
    assert response.headers["Retry-After"] == "7"


def test_conflict_names_the_field(app: FastAPI) -> None:
    assert TestClient(app).get("/raise/CONFLICT").json()["error"]["details"] == {"field": "name"}


def test_forbidden_and_rate_limited_emit_security_events(app: FastAPI) -> None:
    client = TestClient(app)
    client.get("/raise/FORBIDDEN")
    client.get("/raise/RATE_LIMITED")
    client.get("/raise/NOT_FOUND")
    actions = [event.action for event in app.state.recorded]
    assert actions == ["ACCESS_DENIED", "RATE_LIMITED"]
    # The route template as registered, never the concrete path.
    assert app.state.recorded[0].metadata == {"method": "GET", "route": "/raise/{code}"}


def test_request_validation_maps_to_fields(app: FastAPI) -> None:
    response = TestClient(app).post("/validate", json={"age": "not-a-number"})
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "VALIDATION_ERROR"
    fields = response.json()["error"]["details"]["fields"]
    assert set(fields) == {"email", "age"}
    assert "not-a-number" not in response.text


def test_validation_fields_mapping() -> None:
    fields = validation_fields(
        [
            {
                "type": "value_error",
                "loc": ("body", "visitor", "email"),
                "msg": "Value error, Enter a valid email address.",
            },
            {"type": "value_error", "loc": ("body", "visitor", "email"), "msg": "second message is ignored"},
            {"type": "greater_than_equal", "loc": ("query", "page"), "msg": "...", "ctx": {"ge": 1}},
            {"type": "json_invalid", "loc": ("body", 17), "msg": "JSON decode error", "ctx": {"error": "x"}},
        ]
    )
    assert fields == {
        "visitor.email": "Enter a valid email address.",
        "page": "Enter a value of at least 1.",
        "body": "The request body is not valid JSON.",
    }


# ---- user-facing field messages (contract §8.2) ---------------------------------------------------


class _Sample(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: Annotated[str, StringConstraints(min_length=1, max_length=5)]
    code: Annotated[str, StringConstraints(min_length=3)] = "abc"
    count: Annotated[int, Field(ge=1, le=10)] = 1
    ratio: Annotated[float, Field(gt=0, lt=1)] = 0.5
    flag: bool = False
    when: AwareDatetime | None = None
    day: date | None = None
    ref: UUID | None = None
    kind: Literal["QR", "MANUAL"] = "QR"
    role: Role = Role.EMPLOYEE
    tags: Annotated[list[str], Field(min_length=1, max_length=2)] = ["a"]
    checked: str | None = None

    @field_validator("checked")
    @classmethod
    def _custom(cls, value: str | None) -> str | None:
        if value == "bad":
            raise ValueError("This value is not acceptable.")
        return value


def _messages(**values: object) -> dict[str, str]:
    with pytest.raises(ValidationError) as caught:
        _Sample.model_validate({"name": "ok", **values})
    return validation_fields([{**error, "loc": ("body", *error["loc"])} for error in caught.value.errors()])


ROLE_CHOICES = "Choose one of: 'SYSTEM_ADMIN', 'EMPLOYEE', 'RECEPTIONIST' or 'MANAGEMENT'."
ZONE_HINT = "Include a time zone, e.g. 2026-10-05T09:00:00+03:00."


@pytest.mark.parametrize(
    ("values", "expected"),
    [
        ({"name": None}, {"name": "Enter text."}),
        ({"name": ""}, {"name": "This field is required."}),
        ({"name": "toolong"}, {"name": "Enter at most 5 characters."}),
        ({"code": "ab"}, {"code": "Enter at least 3 characters."}),
        ({"count": 0}, {"count": "Enter a value of at least 1."}),
        ({"count": 11}, {"count": "Enter a value of at most 10."}),
        ({"count": "many"}, {"count": "Enter a whole number."}),
        ({"count": 1.5}, {"count": "Enter a whole number."}),
        ({"ratio": 0}, {"ratio": "Enter a value greater than 0."}),
        ({"ratio": 1}, {"ratio": "Enter a value less than 1."}),
        ({"ratio": "x"}, {"ratio": "Enter a number."}),
        ({"flag": "perhaps"}, {"flag": "Choose true or false."}),
        ({"when": "2026-10-05T09:00:00"}, {"when": ZONE_HINT}),
        ({"when": "yesterday"}, {"when": "Enter a valid date and time."}),
        ({"day": "05/10/2026"}, {"day": "Enter a valid date (YYYY-MM-DD)."}),
        ({"ref": "not-a-uuid"}, {"ref": "Enter a valid ID."}),
        ({"kind": "FAX"}, {"kind": "Choose one of: 'QR' or 'MANUAL'."}),
        ({"role": "ROOT"}, {"role": ROLE_CHOICES}),
        ({"tags": []}, {"tags": "Select at least 1 item."}),
        ({"tags": ["a", "b", "c"]}, {"tags": "Select at most 2 items."}),
        ({"tags": "a"}, {"tags": "Enter a list of values."}),
        ({"unknown": 1}, {"unknown": "This field is not allowed."}),
        ({"checked": "bad"}, {"checked": "This value is not acceptable."}),
    ],
)
def test_field_messages_are_written_for_people(values: dict, expected: dict[str, str]) -> None:
    assert _messages(**values) == expected


def test_missing_field_and_unknown_error_types() -> None:
    with pytest.raises(ValidationError) as caught:
        _Sample.model_validate({})
    assert validation_fields(caught.value.errors()) == {"name": "This field is required."}
    unknown = {"type": "some_future_type", "loc": ("body", "x"), "msg": "Raw developer wording"}
    assert validation_fields([unknown]) == {"x": "Enter a valid value."}


def test_messages_never_echo_the_rejected_input() -> None:
    secret = "do-not-echo-me-0123456789"
    fields = _messages(name=secret, ref=secret, kind=secret, count=secret, when=secret)
    assert all(secret not in message for message in fields.values())


# ---- discriminated unions: no tag segment in field paths --------------------------------------------


class _Nested(BaseModel):
    steps: list[CheckInRequest]


@pytest.fixture
def union_app() -> FastAPI:
    app = FastAPI()
    register_exception_handlers(app)

    @app.post("/check-in")
    def check_in(body: CheckInRequest) -> None:
        return None

    @app.post("/check-out")
    def check_out(body: CheckOutRequest) -> None:
        return None

    @app.post("/nested")
    def nested(body: _Nested) -> None:
        return None

    return app


REQUIRED = "This field is required."


@pytest.mark.parametrize(
    ("path", "body", "expected"),
    [
        ("/check-in", {"method": "OVERRIDE", "reason": ""}, {"reason": REQUIRED}),
        ("/check-in", {"method": "OVERRIDE"}, {"reason": REQUIRED}),
        ("/check-in", {"method": "MANUAL", "reason": "x"}, {"reason": "This field is not allowed."}),
        ("/check-in", {"method": "QR", "pass_token": 5}, {"pass_token": "Enter text."}),
        ("/check-out", {"method": "CORRECTED"}, {"check_out_at": REQUIRED, "note": REQUIRED}),
        (
            "/check-out",
            {"method": "CORRECTED", "check_out_at": "2026-10-05T09:00:00", "note": "Left early"},
            {"check_out_at": ZONE_HINT},
        ),
        ("/check-in", {}, {"method": REQUIRED}),
        ("/check-in", {"method": "TELEPATHY"}, {"method": "Choose one of: 'QR', 'MANUAL', 'OVERRIDE'."}),
        (
            "/nested",
            {"steps": [{"method": "MANUAL"}, {"method": "OVERRIDE", "reason": ""}]},
            {"steps.1.reason": REQUIRED},
        ),
    ],
)
def test_union_errors_use_the_request_field_names(
    union_app: FastAPI, path: str, body: dict, expected: dict[str, str]
) -> None:
    response = TestClient(union_app).post(path, json=body)
    assert response.status_code == 422
    assert response.json()["error"]["details"]["fields"] == expected


def test_malformed_json_body_names_the_body(app: FastAPI) -> None:
    response = TestClient(app).post(
        "/validate", content=b'{"email": "a@b.c", bad', headers={"Content-Type": "application/json"}
    )
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "VALIDATION_ERROR"
    assert response.json()["error"]["details"] == {
        "fields": {"body": "The request body is not valid JSON."},
        "field_codes": {"body": {"code": "invalid_json", "params": {}}},
    }


def test_pass_invalid_is_audited_as_an_invalid_scan(app: FastAPI) -> None:
    TestClient(app).get("/raise/PASS_INVALID")
    [event] = app.state.recorded
    assert event.action == "PASS_SCANNED"
    assert event.metadata == {"outcome": "INVALID"}
    assert event.entity_id is None and event.entity_type is None


def test_unparsable_path_id_is_not_found(app: FastAPI) -> None:
    # Contract §3.2-5: an unresolvable path ID is 404, even when the body is invalid as well.
    response = TestClient(app).post("/items/not-a-uuid", json={})
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "NOT_FOUND"


PRIVATE = "dana.private@example.com"


class _Person(BaseModel):
    name: str
    age: int


@pytest.fixture
def response_app() -> FastAPI:
    app = FastAPI()
    register_exception_handlers(app)

    @app.get("/people/{person_id}", response_model=_Person)
    def bad_response(person_id: str) -> dict[str, object]:
        # A response that does not match its model, carrying personal data.
        return {"name": PRIVATE, "age": f"age of {PRIVATE}"}

    @app.get("/built/{person_id}")
    def bad_model(person_id: str) -> _Person:
        return _Person.model_validate({"name": PRIVATE, "age": PRIVATE})

    return app


@pytest.mark.parametrize("path", ["/people/123", "/built/123"])
def test_response_validation_failures_log_no_personal_data(
    response_app: FastAPI, caplog: pytest.LogCaptureFixture, path: str
) -> None:
    from app.core.logging import JsonFormatter

    with caplog.at_level(logging.DEBUG):
        response = TestClient(response_app).get(path)
    assert response.status_code == 500
    assert response.json()["error"] == {
        "code": "INTERNAL_ERROR",
        "message": "Something went wrong. Please try again.",
        "details": {},
    }
    assert PRIVATE not in response.text
    [record] = [record for record in caplog.records if record.name == "app.errors"]
    assert record.levelno == logging.ERROR and record.exc_info is None
    assert record.route == path.replace("123", "{person_id}")
    assert record.validation_errors and all(
        set(error) == {"loc", "type"} for error in record.validation_errors
    )
    formatted = JsonFormatter().format(record)
    assert PRIVATE not in formatted and "age of" not in formatted
    assert all(PRIVATE not in str(item.__dict__) for item in caplog.records)


def test_value_the_database_cannot_store_is_a_validation_error(
    app: FastAPI, caplog: pytest.LogCaptureFixture
) -> None:
    with caplog.at_level(logging.WARNING):
        response = TestClient(app).get("/unstorable")
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "VALIDATION_ERROR"
    assert response.json()["error"]["details"] == {
        "fields": {"body": errors.UNSTORABLE_VALUE},
        "field_codes": {"body": {"code": "unstorable_value", "params": {}}},
    }
    assert not any(record.exc_info for record in caplog.records)  # a client error, not a traceback


def test_date_arithmetic_overflow_is_a_validation_error_without_a_traceback(
    app: FastAPI, caplog: pytest.LogCaptureFixture
) -> None:
    with caplog.at_level(logging.WARNING):
        response = TestClient(app).get("/overflow")
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "VALIDATION_ERROR"
    assert response.json()["error"]["details"] == {
        "fields": {"body": errors.OUT_OF_RANGE_VALUE},
        "field_codes": {"body": {"code": "out_of_range", "params": {}}},
    }
    assert [record.levelno for record in caplog.records] == [logging.WARNING]
    assert not any(record.exc_info for record in caplog.records)
