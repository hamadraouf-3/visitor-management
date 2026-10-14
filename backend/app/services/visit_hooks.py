"""The visit side of the Phase-1 hand-over hooks, wired by `create_app` as the defaults.

* D-18 `HostedVisitCancellations`: when a user is deactivated or loses their last host role,
  `UsersService.update_user` calls it in its own transaction, after locking the company and the user
  (`repositories.locking`). Every SCHEDULED visit the user hosts is cancelled with the reason "Host is
  no longer available" (pass revoked, visitor notified by e-mail when an invitation was requested for
  the visit, VISIT_CANCELLED audited); visits whose window already ended become NO_SHOW instead. The
  e-mail jobs are delivered after that transaction commits.
* D-17 `VisitSnapshots`: a host's new name and a department's new names (in either language) are copied
  into the snapshots of their SCHEDULED visits in the renaming transaction; checked-in and later visits
  keep theirs.
"""

from datetime import datetime

from sqlalchemy.orm import Session

from app.core import time as app_time
from app.core.policy import HOST_UNAVAILABLE_REASON
from app.core.request_context import RequestContext
from app.email.service import DeliveryJob
from app.models import Department, User
from app.repositories.companies import CompanyRepository
from app.repositories.visits import VisitRepository
from app.security.sessions import AuthContext
from app.services.environment import ServiceEnvironment
from app.services.no_shows import mark_if_expired, mark_no_shows
from app.services.scoping import require_found
from app.services.users import HostedVisitCancellation
from app.services.visit_lifecycle import VisitLifecycle


class HostedVisitCancellations:
    """`services.users.HostedVisitCanceller` (D-18)."""

    def __init__(self, env: ServiceEnvironment) -> None:
        self.env = env

    def cancel_hosted_visits(
        self, db: Session, *, host: User, actor: AuthContext, context: RequestContext, now: datetime
    ) -> HostedVisitCancellation:
        mark_no_shows(db, host.company_id, now=now)
        company = require_found(CompanyRepository(db).get(host.company_id))
        lifecycle = VisitLifecycle(db, self.env)
        cancelled = 0
        jobs: list[DeliveryJob] = []
        visits = VisitRepository(db).lock_scheduled_hosted_by(host.company_id, host.id)
        now = app_time.now()  # once the locks are held: after any change this one waited for
        for visit in visits:
            if mark_if_expired(db, visit, now=now):
                continue
            job = lifecycle.cancel(
                visit,
                company=company,
                actor_id=actor.user_id,
                reason=HOST_UNAVAILABLE_REASON,
                notify=True,
                trigger="host_unavailable",
                context=context,
                now=now,
            )
            cancelled += 1
            if job is not None:
                jobs.append(job)
        return HostedVisitCancellation(cancelled=cancelled, delivery_jobs=tuple(jobs))


class VisitSnapshots:
    """`services.visit_snapshots.VisitSnapshotRefresher` (D-17)."""

    def host_renamed(self, db: Session, *, host: User, now: datetime) -> int:
        return VisitRepository(db).refresh_host_name(host.company_id, host.id, host.full_name, now=now)

    def department_renamed(self, db: Session, *, department: Department, now: datetime) -> int:
        return VisitRepository(db).refresh_department_names(
            department.company_id, department.id, department.name, department.name_ar, now=now
        )
