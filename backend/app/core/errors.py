"""Application errors and the uniform error envelope (contract §8 / §8.2).

Every non-2xx response has the shape
`{"error": {"code", "message", "details"}, "request_id"}`. Services raise `AppError` subclasses; the
handlers registered by `register_exception_handlers` turn them (and framework errors) into envelopes.
Unexpected exceptions are turned into a 500 by the request-context middleware without internals.
"""

import logging
import re
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, ClassVar, Protocol
from uuid import UUID

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError, ResponseValidationError
from fastapi.responses import JSONResponse, Response
from pydantic import ValidationError
from sqlalchemy.exc import DataError, OperationalError
from sqlalchemy.exc import TimeoutError as PoolTimeoutError
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.core.field_errors import FieldCode, FieldProblem, FieldValueError, ParamValue
from app.core.request_context import current_request_id
from app.core.routing import route_template

logger = logging.getLogger("app.errors")


@dataclass(frozen=True, slots=True)
class SecurityEvent:
    """A failure/denial to audit through the independent security-event writer (§7.4).

    `company_id`/`actor_user_id` left as None are filled from the authenticated request when there is
    one. `metadata` holds IDs, enums and counts only. Events of the platform realm (`platform`, every
    request under /api/v1/platform) go to the platform's own trail.
    """

    action: str
    company_id: UUID | None = None
    actor_user_id: UUID | None = None
    entity_type: str | None = None
    entity_id: UUID | None = None
    metadata: Mapping[str, Any] = field(default_factory=dict)
    attribute_to_request_user: bool = True
    # An event of the platform owner's realm (B11-4): written to `platform_audit_logs`, where
    # `actor_user_id` names a platform administrator and `company_id` the company it was about, if any.
    platform: bool = False


class AppError(Exception):
    status_code: ClassVar[int] = 500
    code: ClassVar[str] = "INTERNAL_ERROR"
    default_message: ClassVar[str] = "Something went wrong. Please try again."

    def __init__(
        self,
        message: str | None = None,
        *,
        details: Mapping[str, Any] | None = None,
        headers: Mapping[str, str] | None = None,
        security_events: Sequence[SecurityEvent] = (),
    ) -> None:
        self.message = message or self.default_message
        self.details: dict[str, Any] = dict(details or {})
        self.headers: dict[str, str] = dict(headers or {})
        self.security_events: tuple[SecurityEvent, ...] = tuple(security_events)
        super().__init__(self.message)

    def default_security_events(self, request: Request) -> tuple[SecurityEvent, ...]:
        """Events audited when the raiser attached none (e.g. every 403 FORBIDDEN is ACCESS_DENIED)."""
        return ()


def _route_metadata(request: Request) -> dict[str, str]:
    """Method and route template (never the concrete path, which carries IDs and arbitrary input)."""
    return {"method": request.method, "route": route_template(request.scope)}


# ---- 400 ----------------------------------------------------------------------------------------


class InvalidResetToken(AppError):
    status_code = 400
    code = "INVALID_RESET_TOKEN"
    default_message = "This password reset link is invalid or has expired."


class InvalidCurrentPassword(AppError):
    status_code = 400
    code = "INVALID_CURRENT_PASSWORD"
    default_message = "Your current password is incorrect."


class BadRequest(AppError):
    status_code = 400
    code = "BAD_REQUEST"
    default_message = "The request could not be processed."


# ---- 401 / 403 ----------------------------------------------------------------------------------


class NotAuthenticated(AppError):
    status_code = 401
    code = "NOT_AUTHENTICATED"
    default_message = "Please sign in."


class InvalidCredentials(AppError):
    status_code = 401
    code = "INVALID_CREDENTIALS"
    default_message = "Invalid email or password."


class Forbidden(AppError):
    status_code = 403
    code = "FORBIDDEN"
    default_message = "You do not have permission to perform this action."

    def default_security_events(self, request: Request) -> tuple[SecurityEvent, ...]:
        return (SecurityEvent(action="ACCESS_DENIED", metadata=_route_metadata(request)),)


class CsrfFailed(AppError):
    status_code = 403
    code = "CSRF_FAILED"
    default_message = "Your session could not be verified. Please refresh the page and try again."


class PasswordChangeRequired(AppError):
    status_code = 403
    code = "PASSWORD_CHANGE_REQUIRED"
    default_message = "You must change your password before continuing."


# ---- 404 / 405 ----------------------------------------------------------------------------------


class NotFound(AppError):
    status_code = 404
    code = "NOT_FOUND"
    default_message = "The requested item was not found."


class PassInvalid(AppError):
    """§6 row 1 (malformed input, unknown pass, another company's pass). Audited as
    PASS_SCANNED{outcome: INVALID} with no entity and nothing from the input."""

    status_code = 404
    code = "PASS_INVALID"
    default_message = "Invalid visitor pass."

    def default_security_events(self, request: Request) -> tuple[SecurityEvent, ...]:
        return (SecurityEvent(action="PASS_SCANNED", metadata={"outcome": "INVALID"}),)


class MethodNotAllowed(AppError):
    status_code = 405
    code = "METHOD_NOT_ALLOWED"
    default_message = "This method is not allowed for the requested resource."


# ---- 408 / 413 / 415 ----------------------------------------------------------------------------


class RequestTimeout(AppError):
    """The body of a request did not arrive in the time the endpoint waits for it: the upload of a
    company's brand image, the one body the API reads while it arrives (B12-18). No code of its own:
    like every other 4xx outside the contract's list it is a BAD_REQUEST, told apart by its status."""

    status_code = 408
    code = "BAD_REQUEST"
    default_message = "The request did not arrive in time. Please try again."


class PayloadTooLarge(AppError):
    """The request body exceeds MAX_REQUEST_BODY_BYTES (`core.middleware.BodySizeLimitMiddleware`)."""

    status_code = 413
    code = "PAYLOAD_TOO_LARGE"
    default_message = "The request is too large."


class UnsupportedMediaType(AppError):
    """The request body is not of the one type the endpoint takes: a company's brand image is uploaded
    as `image/png` (B12-6)."""

    status_code = 415
    code = "UNSUPPORTED_MEDIA_TYPE"
    default_message = "This type of content is not supported here."


# ---- 409 ----------------------------------------------------------------------------------------


class Conflict(AppError):
    """Generic uniqueness conflict; `details.field` names the offending field."""

    status_code = 409
    code = "CONFLICT"
    default_message = "This value is already in use."

    def __init__(self, field_name: str, message: str | None = None, **kwargs: Any) -> None:
        details = {"field": field_name, **dict(kwargs.pop("details", None) or {})}
        super().__init__(message, details=details, **kwargs)


class UserEmailUnavailable(AppError):
    status_code = 409
    code = "USER_EMAIL_UNAVAILABLE"
    default_message = "This email address cannot be used."


class LastAdmin(AppError):
    status_code = 409
    code = "LAST_ADMIN"
    default_message = "The company must keep at least one active administrator."


class SelfModification(AppError):
    status_code = 409
    code = "SELF_MODIFICATION"
    default_message = "You cannot remove your own administrator access or deactivate yourself."


class CompanyInactive(AppError):
    """The company is deactivated (B11-10). Two callers: the platform owner acted on it where that means
    nothing (a reset link, B11-11); or one of its users signed in with valid credentials, and the
    deactivation is the only obstacle (B11-46). One code, one status, one message."""

    status_code = 409
    code = "COMPANY_INACTIVE"
    default_message = "This company is deactivated."


class AccountInactive(AppError):
    """The platform owner asked for a reset link of a deactivated administrator (B11-11)."""

    status_code = 409
    code = "ACCOUNT_INACTIVE"
    default_message = "This account is deactivated."


class VisitorExists(AppError):
    status_code = 409
    code = "VISITOR_EXISTS"
    default_message = "A visitor with this email already exists."


class InvalidStateTransition(AppError):
    status_code = 409
    code = "INVALID_STATE_TRANSITION"
    default_message = "This action is not allowed for the visit's current status."


class VisitNotEditable(AppError):
    status_code = 409
    code = "VISIT_NOT_EDITABLE"
    default_message = "Only scheduled visits can be changed."


class VisitAlreadyCheckedIn(AppError):
    status_code = 409
    code = "VISIT_ALREADY_CHECKED_IN"
    default_message = "This visitor is already checked in."


class VisitNotCheckedIn(AppError):
    status_code = 409
    code = "VISIT_NOT_CHECKED_IN"
    default_message = "This visitor is not checked in."


class VisitorAlreadyInside(AppError):
    status_code = 409
    code = "VISITOR_ALREADY_INSIDE"
    default_message = "This visitor is already checked in on another visit."


class VisitCancelled(AppError):
    status_code = 409
    code = "VISIT_CANCELLED"
    default_message = "This visit has been cancelled."


class VisitCompleted(AppError):
    status_code = 409
    code = "VISIT_COMPLETED"
    default_message = "This visit has already been completed."


class HostInactive(AppError):
    status_code = 409
    code = "HOST_INACTIVE"
    default_message = (
        "The host for this visit is no longer active. Register the visitor as a walk-in with a current host."
    )


class PassNotYetValid(AppError):
    status_code = 409
    code = "PASS_NOT_YET_VALID"
    default_message = "This visitor pass is not valid yet."


class VisitorEmailRequired(AppError):
    status_code = 409
    code = "VISITOR_EMAIL_REQUIRED"
    default_message = "The visitor needs an email address to receive an invitation."


class WalkInsDisabled(AppError):
    status_code = 409
    code = "WALK_INS_DISABLED"
    default_message = "Walk-in registration is disabled for this company."


class OverrideNotAllowed(AppError):
    status_code = 409
    code = "OVERRIDE_NOT_ALLOWED"
    default_message = "This visit cannot be checked in with an override."


class TrackingNotAvailable(AppError):
    """Visitor tracking cannot be used for this request (Phase 15, B15-14): the deployment's provider is
    `disabled`, the platform owner has not allowed it for the company, or the company has not switched it
    on. `details.reason` says which (`PROVIDER_DISABLED`, `NOT_ALLOWED`, `NOT_ENABLED`)."""

    status_code = 409
    code = "TRACKING_NOT_AVAILABLE"
    default_message = "Visitor tracking is not available for this request."

    def __init__(self, reason: str, message: str | None = None) -> None:
        super().__init__(message, details={"reason": reason})
        self.reason = reason


class TrackingKeyLimit(AppError):
    """A company holds at most two unrevoked tracking keys, for a rotation (B15-10)."""

    status_code = 409
    code = "TRACKING_KEY_LIMIT"
    default_message = "This company already has two active tracking keys. Revoke one first."


class LocationInUse(AppError):
    """A building, floor or zone cannot be archived while it holds active floors, zones or cameras
    (B15-5)."""

    status_code = 409
    code = "LOCATION_IN_USE"
    default_message = "Archive the floors, zones and cameras in it first."


# ---- 410 ----------------------------------------------------------------------------------------


class PassExpired(AppError):
    status_code = 410
    code = "PASS_EXPIRED"
    default_message = "This visitor pass has expired."


class PassRevoked(AppError):
    status_code = 410
    code = "PASS_REVOKED"
    default_message = (
        "This visitor pass has been replaced. Ask the visitor for their latest invitation, "
        "or verify their ID and check in manually."
    )


# ---- 422 ----------------------------------------------------------------------------------------


class ValidationFailed(AppError):
    """422 VALIDATION_ERROR with `details.fields = {path: message}` and, for the same paths,
    `details.field_codes = {path: {"code", "params"}}` (`app.core.field_errors`, B10-18)."""

    status_code = 422
    code = "VALIDATION_ERROR"
    default_message = "Please correct the highlighted fields."

    def __init__(self, fields: Mapping[str, FieldProblem], message: str | None = None, **kwargs: Any) -> None:
        super().__init__(message, details=validation_details(fields), **kwargs)
        self.fields = dict(fields)


def validation_details(problems: Mapping[str, FieldProblem]) -> dict[str, Any]:
    """`details` of a 422: the messages (`fields`) and the codes (`field_codes`) of the same paths."""
    return {
        "fields": {path: problem.message for path, problem in problems.items()},
        "field_codes": {path: problem.detail() for path, problem in problems.items()},
    }


# ---- 429 / 5xx ----------------------------------------------------------------------------------


class _Throttled(AppError):
    status_code = 429

    def __init__(self, message: str | None = None, *, retry_after: int, **kwargs: Any) -> None:
        headers = {"Retry-After": str(max(1, int(retry_after))), **dict(kwargs.pop("headers", None) or {})}
        super().__init__(message, headers=headers, **kwargs)
        self.retry_after = max(1, int(retry_after))


class RateLimited(_Throttled):
    code = "RATE_LIMITED"
    default_message = "Too many requests. Please wait and try again."

    def __init__(self, message: str | None = None, *, retry_after: int, policy: str, **kwargs: Any) -> None:
        super().__init__(message, retry_after=retry_after, **kwargs)
        self.policy = policy

    def default_security_events(self, request: Request) -> tuple[SecurityEvent, ...]:
        return (
            SecurityEvent(
                action="RATE_LIMITED", metadata={"policy": self.policy, **_route_metadata(request)}
            ),
        )


class InvitationLimit(_Throttled):
    code = "INVITATION_LIMIT"
    default_message = "Invitation limit reached. Please try again later."

    def __init__(self, message: str | None = None, *, retry_after: int, policy: str, **kwargs: Any) -> None:
        super().__init__(message, retry_after=retry_after, **kwargs)
        self.policy = policy

    def default_security_events(self, request: Request) -> tuple[SecurityEvent, ...]:
        return (
            SecurityEvent(
                action="RATE_LIMITED", metadata={"policy": self.policy, **_route_metadata(request)}
            ),
        )


class ServiceBusy(AppError):
    status_code = 503
    code = "SERVICE_BUSY"
    default_message = "The service is busy. Please try again."


class InternalError(AppError):
    status_code = 500
    code = "INTERNAL_ERROR"
    default_message = "Something went wrong. Please try again."


# ---- envelope -----------------------------------------------------------------------------------


def error_body(code: str, message: str, details: Mapping[str, Any] | None = None) -> dict[str, Any]:
    return {
        "error": {"code": code, "message": message, "details": dict(details or {})},
        "request_id": current_request_id(),
    }


def error_response(
    status_code: int,
    code: str,
    message: str,
    details: Mapping[str, Any] | None = None,
    headers: Mapping[str, str] | None = None,
) -> JSONResponse:
    return JSONResponse(
        status_code=status_code, content=error_body(code, message, details), headers=dict(headers or {})
    )


def app_error_response(exc: AppError) -> JSONResponse:
    return error_response(exc.status_code, exc.code, exc.message, exc.details, exc.headers)


def internal_error_body() -> dict[str, Any]:
    return error_body(InternalError.code, InternalError.default_message)


# ---- handlers -----------------------------------------------------------------------------------


class SecurityEventSink(Protocol):
    def __call__(self, request: Request, event: SecurityEvent) -> None: ...


_LOCATION_ROOTS = frozenset({"body", "query", "path", "header", "cookie"})
INVALID_JSON_MESSAGE = "The request body is not valid JSON."
_GENERIC_MESSAGE = "Enter a valid value."


def _strip_union_tags(parts: Sequence[str | int], body: Any) -> list[str | int]:
    """Drop the tag segments Pydantic inserts for discriminated unions.

    For `{"method": "OVERRIDE", "reason": ""}` against a union discriminated by `method`, the error is
    located at `("OVERRIDE", "reason")`; the field the client sent is `reason`. Walking the location
    through the submitted body identifies a tag: a segment that is not a key of the current object but
    equals one of its string values (the discriminator's value).
    """
    kept: list[str | int] = []
    node = body
    for part in parts:
        if isinstance(node, dict):
            if part in node:
                kept.append(part)
                node = node[part]
                continue
            if isinstance(part, str) and part in {value for value in node.values() if isinstance(value, str)}:
                continue  # union tag: stay on the same object
        elif isinstance(node, list) and isinstance(part, int) and 0 <= part < len(node):
            kept.append(part)
            node = node[part]
            continue
        kept.append(part)
        node = None  # beyond what the client sent (e.g. a missing field)
    return kept


def _validation_path(error: Mapping[str, Any], body: Any = None) -> str:
    loc = tuple(error.get("loc", ()))
    if error.get("type") == "json_invalid":
        return "body"  # the location's second part is a character offset, not a field
    root, parts = (loc[0], loc[1:]) if loc and loc[0] in _LOCATION_ROOTS else (None, loc)
    if root == "body":
        parts = tuple(_strip_union_tags(parts, body))
    if error.get("type") in {"union_tag_invalid", "union_tag_not_found"}:
        # The problem is the discriminator itself (`method`), reported where the union sits.
        discriminator = str((error.get("ctx") or {}).get("discriminator", "")).strip("'")
        if discriminator:
            parts = (*parts, discriminator)
    return ".".join(str(part) for part in parts) or (root or "body")


_GENERIC = FieldProblem(FieldCode.INVALID, _GENERIC_MESSAGE)
_QUOTED_CHOICE = re.compile(r"'((?:[^'\\]|\\.)*)'")


def _number(value: object) -> ParamValue | None:
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    return int(value) if isinstance(value, float) and value.is_integer() else value


def _plural(count: object, singular: str, plural: str) -> str:
    return singular if count == 1 else plural


def _bounded(code: FieldCode, template: str, ctx: Mapping[str, Any], key: str, param: str) -> FieldProblem:
    """A number outside a bound of the schema (`ctx[key]`): "Enter a value of at least 1."."""
    value = _number(ctx.get(key))
    if value is None:
        return _GENERIC
    return FieldProblem(code, template.format(value), {param: value})


def _counted(code: FieldCode, template: str, ctx: Mapping[str, Any], key: str, param: str) -> FieldProblem:
    """A length outside a bound of the schema: "Enter at most 500 characters.", "Select at least 1 item."."""
    value = _number(ctx.get(key))
    if value is None:
        return _GENERIC
    noun = ("character", "characters") if "{characters}" in template else ("item", "items")
    word = _plural(value, *noun)
    return FieldProblem(code, template.format(value, characters=word, items=word), {param: value})


def _choices(ctx: Mapping[str, Any], key: str) -> FieldProblem:
    """ "Choose one of: 'a', 'b' or 'c'." with `choices: ["a", "b", "c"]`, the values Pydantic quotes in its
    context (the schema's own enumeration values)."""
    expected = ctx.get(key)
    if not isinstance(expected, str):
        return _GENERIC
    choices = tuple(match.replace("\\'", "'") for match in _QUOTED_CHOICE.findall(expected))
    return FieldProblem(FieldCode.INVALID_CHOICE, f"Choose one of: {expected}.", {"choices": choices})


REQUIRED = FieldProblem(FieldCode.REQUIRED, "This field is required.")


def _same(problem: FieldProblem, *kinds: str) -> dict[str, FieldProblem]:
    return dict.fromkeys(kinds, problem)


# Pydantic error types that need no value from the schema -> the problem reported for them.
_SIMPLE: dict[str, FieldProblem] = {
    **_same(REQUIRED, "missing", "union_tag_not_found"),
    **_same(FieldProblem(FieldCode.INVALID_JSON, INVALID_JSON_MESSAGE), "json_invalid"),
    **_same(
        FieldProblem(FieldCode.INVALID_TEXT, "Enter text."),
        "string_type",
        "string_unicode",
        "string_sub_type",
    ),
    **_same(
        FieldProblem(FieldCode.INVALID_FORMAT, "Enter a value in the expected format."),
        "string_pattern_mismatch",
    ),
    **_same(
        FieldProblem(FieldCode.OFFSET_REQUIRED, "Include a time zone, e.g. 2026-10-05T09:00:00+03:00."),
        "timezone_aware",
    ),
    **_same(FieldProblem(FieldCode.OFFSET_NOT_ALLOWED, "Leave out the time zone."), "timezone_naive"),
    **_same(
        FieldProblem(FieldCode.INVALID_DATETIME, "Enter a valid date and time."),
        "datetime_type",
        "datetime_parsing",
        "datetime_from_date_parsing",
        "datetime_object_invalid",
    ),
    **_same(
        FieldProblem(FieldCode.INVALID_DATE, "Enter a valid date (YYYY-MM-DD)."),
        "date_type",
        "date_parsing",
        "date_from_datetime_parsing",
        "date_from_datetime_inexact",
    ),
    **_same(
        FieldProblem(FieldCode.INVALID_ID, "Enter a valid ID."), "uuid_type", "uuid_parsing", "uuid_version"
    ),
    **_same(
        FieldProblem(FieldCode.INVALID_INTEGER, "Enter a whole number."),
        "int_type",
        "int_parsing",
        "int_from_float",
        "int_parsing_size",
    ),
    **_same(
        FieldProblem(FieldCode.INVALID_NUMBER, "Enter a number."),
        "float_type",
        "float_parsing",
        "decimal_type",
        "decimal_parsing",
        "finite_number",
    ),
    **_same(FieldProblem(FieldCode.INVALID_BOOLEAN, "Choose true or false."), "bool_type", "bool_parsing"),
    **_same(
        FieldProblem(FieldCode.INVALID_LIST, "Enter a list of values."), "list_type", "tuple_type", "set_type"
    ),
    **_same(
        FieldProblem(FieldCode.INVALID_OBJECT, "Enter an object with the expected fields."),
        "model_type",
        "model_attributes_type",
        "dict_type",
    ),
    **_same(FieldProblem(FieldCode.NOT_ALLOWED, "This field is not allowed."), "extra_forbidden"),
}


def field_problem(error: Mapping[str, Any]) -> FieldProblem:
    """The problem of one Pydantic error, with its code (contract §8.2: field messages are user-facing;
    B10-18: each has a stable code). The rejected input is never echoed; only limits and allowed
    enumeration values from the schema appear. A validator's `FieldValueError` brings its own problem; a
    plain ValueError keeps its message under the generic code `invalid` (no request model raises one:
    tests/unit/test_field_codes.py)."""
    kind = str(error.get("type", ""))
    ctx: Mapping[str, Any] = error.get("ctx") or {}
    raised = ctx.get("error")
    if isinstance(raised, FieldValueError):
        return raised.problem
    if kind in _SIMPLE:
        return _SIMPLE[kind]
    match kind:
        case "value_error" | "assertion_error":
            message = str(error.get("msg") or _GENERIC_MESSAGE)
            for prefix in ("Value error, ", "Assertion failed, "):
                message = message.removeprefix(prefix)
            return FieldProblem(FieldCode.INVALID, message)
        case "string_too_short":
            if ctx.get("min_length") == 1:
                return REQUIRED
            return _counted(FieldCode.TOO_SHORT, "Enter at least {} {characters}.", ctx, "min_length", "min")
        case "string_too_long":
            return _counted(FieldCode.TOO_LONG, "Enter at most {} {characters}.", ctx, "max_length", "max")
        case "too_short":
            return _counted(FieldCode.TOO_FEW_ITEMS, "Select at least {} {items}.", ctx, "min_length", "min")
        case "too_long":
            return _counted(FieldCode.TOO_MANY_ITEMS, "Select at most {} {items}.", ctx, "max_length", "max")
        case "literal_error" | "enum":
            return _choices(ctx, "expected")
        case "union_tag_invalid":
            return _choices(ctx, "expected_tags")
        # Request models use inclusive bounds only (`ge`, `le`): tests/unit/test_field_codes.py.
        case "greater_than_equal":
            return _bounded(FieldCode.TOO_SMALL, "Enter a value of at least {}.", ctx, "ge", "min")
        case "greater_than":
            return _bounded(FieldCode.TOO_SMALL, "Enter a value greater than {}.", ctx, "gt", "min")
        case "less_than_equal":
            return _bounded(FieldCode.TOO_LARGE, "Enter a value of at most {}.", ctx, "le", "max")
        case "less_than":
            return _bounded(FieldCode.TOO_LARGE, "Enter a value less than {}.", ctx, "lt", "max")
        case _:
            return _GENERIC


def validation_problems(errors: Sequence[Mapping[str, Any]], body: Any = None) -> dict[str, FieldProblem]:
    """Map Pydantic errors to `{path: problem}` for `details`. Paths are the request's field names (union
    tags removed, see `_strip_union_tags`); the first problem of a path wins. The rejected input is never
    echoed or logged."""
    problems: dict[str, FieldProblem] = {}
    for error in errors:
        problems.setdefault(_validation_path(error, body), field_problem(error))
    return problems


def validation_fields(errors: Sequence[Mapping[str, Any]], body: Any = None) -> dict[str, str]:
    """`{path: message}`: the messages of `validation_problems` (what the CLI prints)."""
    return {path: problem.message for path, problem in validation_problems(errors, body).items()}


def _handle_app_error(request: Request, exc: AppError) -> JSONResponse:
    events = exc.security_events or exc.default_security_events(request)
    sink: SecurityEventSink | None = getattr(request.app.state, "security_event_sink", None)
    if sink is not None:
        for event in events:
            sink(request, event)
    if exc.status_code >= 500:
        logger.warning("request failed with %s", exc.code)
    return app_error_response(exc)


LOGGED_LOC_ITEM_MAX_LENGTH = 64


def _loggable_loc(loc: Sequence[Any]) -> list[Any]:
    """An error location for the log. Items can be names the client chose (an unknown body key or query
    parameter, `extra_forbidden`), so long ones are cut; the formatter escapes control characters."""
    return [
        item[:LOGGED_LOC_ITEM_MAX_LENGTH] + "…"
        if isinstance(item, str) and len(item) > LOGGED_LOC_ITEM_MAX_LENGTH
        else item
        for item in loc
    ]


def _handle_validation_error(request: Request, exc: RequestValidationError) -> JSONResponse:
    errors = exc.errors()
    logger.info(
        "request validation failed",
        extra={
            "validation_errors": [
                {"loc": _loggable_loc(e.get("loc", ())), "type": e.get("type")} for e in errors
            ]
        },
    )
    if any(tuple(e.get("loc", ()))[:1] == ("path",) for e in errors):
        # A path ID that cannot even be parsed names nothing that exists: 404, like an unknown ID (§3.2-5).
        return app_error_response(NotFound())
    return app_error_response(ValidationFailed(validation_problems(errors, exc.body)))


UNSTORABLE_VALUE = "This request contains a value that cannot be stored."
UNSTORABLE = FieldProblem(FieldCode.UNSTORABLE_VALUE, UNSTORABLE_VALUE)


def _handle_data_error(request: Request, exc: DataError) -> JSONResponse:
    # A value the schemas let through but PostgreSQL rejects (a data exception, SQLSTATE class 22) is a
    # client error, not a server fault: no traceback, no 500.
    logger.warning("database rejected a request value: %s", type(exc.orig).__name__)
    return app_error_response(ValidationFailed({"body": UNSTORABLE}))


OUT_OF_RANGE_VALUE = "This request contains a date or number that is out of range."
OUT_OF_RANGE = FieldProblem(FieldCode.OUT_OF_RANGE, OUT_OF_RANGE_VALUE)


def _handle_overflow_error(request: Request, exc: OverflowError) -> JSONResponse:
    # Backstop for date arithmetic on a client value the schemas let through (they bound dates and
    # instants, `schemas.common`): a client error, answered without a traceback rather than as a 500.
    logger.warning("a request value is out of range: %s", type(exc).__name__)
    return app_error_response(ValidationFailed({"body": OUT_OF_RANGE}))


_HTTP_STATUS_ERRORS: dict[int, type[AppError]] = {
    401: NotAuthenticated,
    403: Forbidden,
    404: NotFound,
    405: MethodNotAllowed,
    413: PayloadTooLarge,
    415: UnsupportedMediaType,
}


def _handle_http_exception(request: Request, exc: StarletteHTTPException) -> JSONResponse:
    if exc.status_code >= 500:
        return app_error_response(InternalError())
    error_class = _HTTP_STATUS_ERRORS.get(exc.status_code, BadRequest)
    return error_response(
        exc.status_code, error_class.code, error_class.default_message, None, dict(exc.headers or {})
    )


def _handle_operational_error(request: Request, exc: OperationalError) -> JSONResponse:
    # Lost connections, deadlocks and serialisation failures: the client may retry.
    logger.warning("database unavailable or contended: %s", type(exc.orig).__name__)
    return app_error_response(ServiceBusy())


def _handle_pool_timeout(request: Request, exc: PoolTimeoutError) -> JSONResponse:
    # Every pooled connection stayed busy for DB_POOL_TIMEOUT_SECONDS (a slow or hung database, or more
    # concurrent work than the pool holds): retryable, like a lost connection, not a server defect.
    logger.warning("no database connection became free in time")
    return app_error_response(ServiceBusy())


def _error_summary(errors: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """Where and what kind of validation failed; never the value (it is response data: names, e-mail
    addresses, visit details)."""
    return [{"loc": list(error.get("loc", ())), "type": error.get("type")} for error in errors]


def _handle_response_validation_error(request: Request, exc: ResponseValidationError) -> JSONResponse:
    # A response that does not match its model is a server defect. Its `str()` and traceback carry the
    # offending response data, so only the route template and the error locations/types are logged.
    logger.error(
        "response validation failed",
        extra={"route": route_template(request.scope), "validation_errors": _error_summary(exc.errors())},
    )
    return app_error_response(InternalError())


def _handle_model_validation_error(request: Request, exc: ValidationError) -> JSONResponse:
    # Request bodies and query parameters are validated by FastAPI (RequestValidationError), so a
    # Pydantic error reaching this handler comes from building a response model in a service or route.
    logger.error(
        "building a response model failed validation",
        extra={"route": route_template(request.scope), "validation_errors": _error_summary(exc.errors())},
    )
    return app_error_response(InternalError())


def _add_handler[E: Exception](
    app: FastAPI, exc_class: type[E], handle: Callable[[Request, E], Response]
) -> None:
    # Starlette types every handler as taking `Exception`; it only ever passes instances of `exc_class`.
    def handler(request: Request, exc: Exception) -> Response:
        if not isinstance(exc, exc_class):
            raise exc
        return handle(request, exc)

    app.add_exception_handler(exc_class, handler)


def register_exception_handlers(app: FastAPI) -> None:
    _add_handler(app, AppError, _handle_app_error)
    _add_handler(app, RequestValidationError, _handle_validation_error)
    _add_handler(app, StarletteHTTPException, _handle_http_exception)
    _add_handler(app, OperationalError, _handle_operational_error)
    _add_handler(app, PoolTimeoutError, _handle_pool_timeout)
    _add_handler(app, DataError, _handle_data_error)
    _add_handler(app, OverflowError, _handle_overflow_error)
    _add_handler(app, ResponseValidationError, _handle_response_validation_error)
    _add_handler(app, ValidationError, _handle_model_validation_error)
