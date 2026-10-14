"""Company settings (contract §8 /company/settings).

The timezone must be known to both Python (`zoneinfo`) and PostgreSQL (`pg_timezone_names`), because
day boundaries are computed in Python and date grouping in SQL. Changing it never rewrites stored UTC
instants (D-15); grace changes apply to visits created or rescheduled afterwards.

`name_ar` (the Arabic name, NULL when unset) and `default_language` (the interface language of users
without a preference and the leading language of visitor e-mails) are audited like every other setting:
COMPANY_SETTINGS_UPDATED names the changed fields, never their values (B10-4). So is `address_ar`, the
address in Arabic (B10-25).
"""

from enum import Enum
from functools import cache
from zoneinfo import available_timezones

from sqlalchemy.orm import Session

from app.core import time as app_time
from app.core.errors import ValidationFailed
from app.core.field_errors import FieldCode, FieldProblem
from app.core.request_context import RequestContext
from app.models import Company
from app.repositories.companies import CompanyRepository
from app.repositories.locking import RowLock
from app.schemas.company import CompanySettingsUpdate
from app.security.sessions import AuthContext
from app.services import audit
from app.services.audit import AuditAction, AuditEntity
from app.services.authorization import require_still_authorized
from app.services.scoping import require_found

UNKNOWN_TIMEZONE = FieldProblem(
    FieldCode.INVALID_TIMEZONE, "Choose a timezone from the list, for example Asia/Amman."
)
_UPDATABLE = (
    "name",
    "name_ar",
    "default_language",
    "timezone",
    "address",
    "address_ar",
    "email_domain",
    "pass_grace_before_minutes",
    "pass_grace_after_minutes",
    "notify_host_on_check_in",
    "allow_walk_ins",
)


@cache
def _python_timezones() -> frozenset[str]:
    return frozenset(available_timezones())


def timezone_known_to_python(name: str) -> bool:
    return name in _python_timezones()


class CompanyService:
    def __init__(self, db: Session) -> None:
        self.db = db
        self.companies = CompanyRepository(db)

    def is_valid_timezone(self, name: str) -> bool:
        return timezone_known_to_python(name) and self.companies.database_knows_timezone(name)

    def get_settings(self, auth: AuthContext) -> Company:
        return require_found(self.companies.get(auth.company_id))

    def update_settings(
        self, auth: AuthContext, data: CompanySettingsUpdate, context: RequestContext
    ) -> Company:
        company = require_found(self.companies.get(auth.company_id, lock=RowLock.UPDATE))
        # A deactivation or demotion of the caller holds this lock until it commits (SEC-07).
        require_still_authorized(self.db, auth, now=app_time.now())
        supplied = data.model_fields_set
        if (
            "timezone" in supplied
            and data.timezone != company.timezone
            and not self.is_valid_timezone(data.timezone or "")
        ):
            raise ValidationFailed({"timezone": UNKNOWN_TIMEZONE})

        changed: list[str] = []
        for name in _UPDATABLE:
            if name not in supplied:
                continue
            value = getattr(data, name)
            if isinstance(value, Enum):  # stored as its text (VARCHAR + CHECK, contract §4)
                value = value.value
            if value != getattr(company, name):
                setattr(company, name, value)
                changed.append(name)
        if not changed:
            return company
        audit.record(
            self.db,
            action=AuditAction.COMPANY_SETTINGS_UPDATED,
            context=context,
            company_id=company.id,
            actor_user_id=auth.user_id,
            entity_type=AuditEntity.COMPANY,
            entity_id=company.id,
            metadata={"changed_fields": changed},
        )
        self.db.commit()
        return company
