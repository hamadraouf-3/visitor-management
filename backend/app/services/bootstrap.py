"""First-administrator bootstrap (`python -m app.cli create-admin`), allowed in production.

Creates a SYSTEM_ADMIN in an existing company, or in a new company created on the way. The e-mail
address is globally unique (D-03): the insert runs in a savepoint and a concurrent duplicate becomes the
same domain error as one found up front, never a traceback. A new company's timezone must be known to
Python and PostgreSQL alike, as for PATCH /company/settings (contract §4).
"""

from dataclasses import dataclass
from uuid import UUID

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.text import is_company_slug
from app.db.errors import unique_violation_constraint
from app.models import Role
from app.security.passwords import PasswordHasherService, password_policy_error
from app.services.company import CompanyService
from app.services.seeding import Seeder, SeedReport
from app.services.users import EMAIL_CONSTRAINT

EMAIL_TAKEN = "a user with this email address already exists"


class BootstrapError(Exception):
    """A user-facing reason why the bootstrap cannot proceed; nothing was written."""


@dataclass(frozen=True, slots=True)
class BootstrappedAdmin:
    user_id: UUID
    email: str
    company_id: UUID
    company_slug: str
    company_created: bool


class AdminBootstrapService:
    def __init__(self, db: Session, *, hasher: PasswordHasherService) -> None:
        self.db = db
        self.hasher = hasher
        self.seeder = Seeder(db, hasher=hasher)

    def bootstrap_admin(
        self,
        *,
        email: str,
        full_name: str,
        password: str,
        company_slug: str,
        company_name: str | None,
        timezone: str,
    ) -> BootstrappedAdmin:
        """`email`, `full_name` and `company_name` are already validated by the API's schema types."""
        if not is_company_slug(company_slug):
            raise BootstrapError("--company-slug must be lowercase letters, digits and hyphens")
        problem = password_policy_error(
            password, email=email, context=(full_name, company_name or "", company_slug)
        )
        if problem is not None:
            raise BootstrapError(problem.message)
        if self.seeder.users.get_by_email(email) is not None:
            raise BootstrapError(EMAIL_TAKEN)  # before the (slow) hashing

        report = SeedReport()
        company = self.seeder.companies.get_by_slug(company_slug)
        if company is None:
            if company_name is None:
                raise BootstrapError("company not found; pass --company-name to create it")
            if not CompanyService(self.db).is_valid_timezone(timezone):
                raise BootstrapError(f"unknown timezone {timezone!r}")
            company = self.seeder.ensure_company(
                slug=company_slug,
                name=company_name,
                timezone=timezone,
                address=None,
                email_domain=None,
                report=report,
            )
        password_hash = self.hasher.hash(password)
        try:
            with self.db.begin_nested():
                user = self.seeder.create_user(
                    company,
                    email=email,
                    full_name=full_name,
                    roles=(Role.SYSTEM_ADMIN,),
                    department=None,
                    phone=None,
                    password_hash=password_hash,
                )
        except IntegrityError as exc:
            self.db.rollback()
            if unique_violation_constraint(exc) == EMAIL_CONSTRAINT:
                raise BootstrapError(EMAIL_TAKEN) from None
            raise
        self.db.commit()
        return BootstrappedAdmin(
            user_id=user.id,
            email=user.email,
            company_id=company.id,
            company_slug=company.slug,
            company_created=bool(report.companies_created),
        )
