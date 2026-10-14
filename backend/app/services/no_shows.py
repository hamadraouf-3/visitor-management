"""NO_SHOW marking (contract §5).

A SCHEDULED visit whose pass window ended is a no-show. `mark_no_shows` marks every such visit of a
company with one `UPDATE … RETURNING` and audits each (VISIT_MARKED_NO_SHOW, no actor). Visit services
call it at the start of every visit-reading or visit-mutating call, and `cli mark-no-shows` runs it for
every company. A single-visit transition also re-checks the deadline under its row lock
(`mark_if_expired`), which covers visits the bulk update skipped because another transaction held them.
"""

from datetime import datetime
from uuid import UUID

from sqlalchemy.orm import Session

from app.core.request_context import SYSTEM_CONTEXT
from app.models import Visit, VisitStatus
from app.repositories.companies import CompanyRepository
from app.repositories.visits import VisitRepository
from app.services import audit
from app.services.audit import AuditAction, AuditEntity
from app.services.visit_rules import assert_transition, window_ended


def _audit(db: Session, company_id: UUID, visit_id: UUID) -> None:
    audit.record(
        db,
        action=AuditAction.VISIT_MARKED_NO_SHOW,
        context=SYSTEM_CONTEXT,
        company_id=company_id,
        actor_user_id=None,
        entity_type=AuditEntity.VISIT,
        entity_id=visit_id,
    )


def mark_no_shows(db: Session, company_id: UUID, *, now: datetime) -> list[UUID]:
    """Mark the company's expired SCHEDULED visits NO_SHOW in the caller's transaction."""
    marked = VisitRepository(db).mark_no_shows(company_id, now=now)
    for visit_id in marked:
        _audit(db, company_id, visit_id)
    return marked


def mark_no_shows_committed(db: Session, company_id: UUID, *, now: datetime) -> list[UUID]:
    """`mark_no_shows` for read-only calls, which otherwise never commit."""
    marked = mark_no_shows(db, company_id, now=now)
    if marked:
        db.commit()
    return marked


def mark_if_expired(db: Session, visit: Visit, *, now: datetime) -> bool:
    """Under the visit's row lock: mark it NO_SHOW if its window ended. True when it was marked."""
    if visit.status != VisitStatus.SCHEDULED or not window_ended(visit.window_end, now):
        return False
    assert_transition(visit.status, VisitStatus.NO_SHOW)
    visit.status = VisitStatus.NO_SHOW.value
    visit.no_show_at = now
    db.flush()
    _audit(db, visit.company_id, visit.id)
    return True


def mark_no_shows_everywhere(db: Session, *, now: datetime) -> dict[UUID, int]:
    """Every company, one transaction each (`cli mark-no-shows`). Returns the count per company."""
    counts: dict[UUID, int] = {}
    for company_id in CompanyRepository(db).list_ids():
        counts[company_id] = len(mark_no_shows(db, company_id, now=now))
        db.commit()
    return counts
