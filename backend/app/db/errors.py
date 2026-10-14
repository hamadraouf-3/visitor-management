"""Helpers for mapping database constraint violations to API errors by constraint name."""

from psycopg import Error as PsycopgError
from psycopg.errors import UniqueViolation
from sqlalchemy.exc import DBAPIError, IntegrityError


def unique_violation_constraint(exc: IntegrityError) -> str | None:
    """Name of the unique constraint/index that `exc` violated, or None for other integrity errors."""
    original = exc.orig
    if isinstance(original, UniqueViolation):
        return original.diag.constraint_name
    return None


def database_error_summary(exc: BaseException) -> dict[str, str] | None:
    """What a log line may say about a database error: the driver error's class, SQLSTATE and constraint
    name. Never its message, whose DETAIL quotes row values (`Key (email)=(…)`, `Failing row contains
    (…)`). None when `exc` is not a database error."""
    if not isinstance(exc, DBAPIError):
        return None
    original = exc.orig
    summary = {"db_error": type(original).__name__ if original is not None else type(exc).__name__}
    if isinstance(original, PsycopgError):
        if original.sqlstate:
            summary["sqlstate"] = original.sqlstate
        if original.diag.constraint_name:
            summary["constraint"] = original.diag.constraint_name
    return summary
