"""Small shared helpers: field-error collection, tenant-scoped repositories."""

import importlib
import inspect
import pkgutil

import pytest

from app import repositories
from app.core.errors import ValidationFailed
from app.core.field_errors import FieldCode, FieldProblem
from app.repositories.audit_logs import AuditLogRepository
from app.repositories.brand import CompanyBrandRepository
from app.repositories.companies import CompanyRepository
from app.repositories.departments import DepartmentRepository
from app.repositories.email_messages import EmailMessageRepository
from app.repositories.email_templates import EmailTemplateOverrideRepository
from app.repositories.passes import PassRepository
from app.repositories.password_resets import PasswordResetRepository
from app.repositories.platform import (
    PlatformAdminRepository,
    PlatformAuditLogRepository,
    PlatformCompanyRepository,
    PlatformSessionRepository,
)
from app.repositories.reports import ReportRepository
from app.repositories.sessions import SessionRepository
from app.repositories.tracking import (
    AccessAreaRepository,
    AssociationRepository,
    CameraRepository,
    JourneyEventRepository,
    LocationRepository,
    TrackingAlertRepository,
    TrackingHealthRepository,
    TrackingKeyRepository,
    TrackingSettingsRepository,
)
from app.repositories.users import UserRepository
from app.repositories.visitors import VisitorRepository
from app.repositories.visits import VisitRepository
from app.services.scoping import REFERENCE_NOT_FOUND, FieldErrors


def test_field_errors_collect_every_problem() -> None:
    errors = FieldErrors()
    assert errors.require("found", "host_id") == "found"
    assert errors.require(None, "department_id") is None
    errors.add("visitor_id", FieldProblem(FieldCode.NOT_FOUND, "Not in your scope."))
    errors.add("visitor_id", FieldProblem(FieldCode.INVALID, "ignored: the first problem wins"))
    assert errors
    with pytest.raises(ValidationFailed) as caught:
        errors.raise_if_any()
    assert caught.value.fields == {
        "department_id": REFERENCE_NOT_FOUND,
        "visitor_id": FieldProblem(FieldCode.NOT_FOUND, "Not in your scope."),
    }
    assert caught.value.details["fields"] == {
        "department_id": "The selected item does not exist.",
        "visitor_id": "Not in your scope.",
    }
    assert caught.value.details["field_codes"] == {
        "department_id": {"code": "not_found", "params": {}},
        "visitor_id": {"code": "not_found", "params": {}},
    }


def test_field_errors_without_problems_do_not_raise() -> None:
    errors = FieldErrors()
    errors.require(object(), "host_id")
    assert not errors
    errors.raise_if_any()


# Repository methods that may run without a company scope, and why (contract §3.1: repositories are
# company-scoped). A new unscoped method must be added here deliberately, never by accident.
UNSCOPED = {
    (UserRepository, "get_by_email"): "authentication: e-mail is globally unique (D-03)",
    (CompanyRepository, "get_by_slug"): "CLI bootstrap/seeding selects the company itself",
    (CompanyRepository, "database_knows_timezone"): "catalog lookup, no tenant data",
    (SessionRepository, "find_live"): "lookup by the hash of a secret session token",
    (SessionRepository, "revoke"): "session ID taken from the authenticated context",
    (SessionRepository, "is_live"): "session ID taken from the authenticated context",
    (SessionRepository, "revoke_all_for_user"): "user ID taken from the authenticated context",
    (PasswordResetRepository, "find_usable"): "lookup by the hash of a secret reset token",
    (PasswordResetRepository, "consume"): "lookup by the hash of a secret reset token",
    (PasswordResetRepository, "invalidate_unused"): "user ID resolved by a scoped or token lookup",
    (EmailMessageRepository, "claim_pending"): "dispatcher: message ID from a job created in-process",
    (EmailMessageRepository, "fail_stale_pending"): "system sweep of every company's lost deliveries",
    (EmailMessageRepository, "mark_sent"): "dispatcher: message ID from a job created in-process",
    (EmailMessageRepository, "record_failed_attempt"): "dispatcher: message ID from a job created in-process",
    (CompanyRepository, "list_ids"): "cli mark-no-shows runs once per company",
    (VisitRepository, "lock_for_maintenance"): "cli e2e-time-travel (refused in production) names a visit ID",
    # The platform owner (B11-1): a principal above every company, with tables of its own.
    (PlatformAdminRepository, "get"): "the platform's own accounts, no tenant data",
    (PlatformAdminRepository, "get_by_email"): "platform sign-in and the CLI: the platform's own accounts",
    (PlatformAdminRepository, "lock_credentials"): "the platform's own accounts, no tenant data",
    (PlatformAdminRepository, "names"): "the platform's own accounts (its audit trail's actors)",
    (PlatformSessionRepository, "find_live"): "lookup by the hash of a secret platform session token",
    (PlatformSessionRepository, "is_live"): "session ID taken from the authenticated platform context",
    (PlatformSessionRepository, "hold_live"): "session ID taken from the authenticated platform context",
    (PlatformSessionRepository, "revoke"): "session ID taken from the authenticated platform context",
    (PlatformSessionRepository, "revoke_all_for_admin"): "the platform's own accounts, no tenant data",
    (PlatformCompanyRepository, "search"): "the platform owner lists the companies themselves (B11-2)",
    (PlatformCompanyRepository, "counts"): "aggregates per company for the platform owner (B11-2)",
    # A company's identity (B12-9): what the sign-in and pass pages read before anyone signs in.
    (CompanyBrandRepository, "images_of"): "the brands of the companies the platform owner lists (B12-7)",
    (CompanyBrandRepository, "active_company"): "public lookup by slug: an active company's own identity",
    (CompanyBrandRepository, "public_image"): "public lookup by slug: an active company's own image",
    (CompanyBrandRepository, "companies_with_logo"): "system: e-mail logos drawn ahead (B13-7), IDs only",
    # The Visitor Journey (Phase 15): the provider is authenticated by its key, which names the company.
    (TrackingKeyRepository, "by_digest"): "lookup by the hash of a secret tracking key (B15-10)",
    (TrackingSettingsRepository, "allowed_of"): "the platform owner lists the companies themselves (B15-2)",
}
REPOSITORIES = [
    AccessAreaRepository,  # Phase 16
    AssociationRepository,
    AuditLogRepository,
    CameraRepository,
    CompanyBrandRepository,
    CompanyRepository,
    DepartmentRepository,
    EmailMessageRepository,
    EmailTemplateOverrideRepository,
    JourneyEventRepository,
    LocationRepository,
    PassRepository,
    PasswordResetRepository,
    PlatformAdminRepository,
    PlatformAuditLogRepository,
    PlatformCompanyRepository,
    PlatformSessionRepository,
    ReportRepository,
    SessionRepository,
    TrackingAlertRepository,  # Phase 16
    TrackingHealthRepository,
    TrackingKeyRepository,
    TrackingSettingsRepository,
    UserRepository,
    VisitorRepository,
    VisitRepository,
]


def test_every_repository_is_covered() -> None:
    found = set()
    for module_info in pkgutil.iter_modules(repositories.__path__):
        module = importlib.import_module(f"{repositories.__name__}.{module_info.name}")
        found |= {
            cls
            for _name, cls in inspect.getmembers(module, inspect.isclass)
            if cls.__name__.endswith("Repository") and cls.__module__ == module.__name__
        }
    assert found == set(REPOSITORIES)


@pytest.mark.parametrize("repository", REPOSITORIES, ids=lambda cls: cls.__name__)
def test_repository_reads_and_writes_are_company_scoped(repository: type) -> None:
    for name, method in inspect.getmembers(repository, inspect.isfunction):
        if name.startswith("_") or name == "add" or (repository, name) in UNSCOPED:
            continue
        parameters = inspect.signature(method).parameters
        assert "company_id" in parameters, f"{repository.__name__}.{name} must take company_id"
