"""Visitor pass data access. Passes are found by the SHA-256 of their token, within the caller's company:
another company's pass is indistinguishable from an unknown one (contract §6 row 1). So is a pass of a
company the platform owner deactivated (B11-10)."""

from collections.abc import Collection
from datetime import datetime, timedelta
from typing import NamedTuple
from uuid import UUID

from sqlalchemy import select, update
from sqlalchemy.dialects.postgresql import distinct_on
from sqlalchemy.orm import Session

from app.models import Company, VisitorPass
from app.repositories.ids import any_of


class CurrentPass(NamedTuple):
    """A visit's current pass as visit responses show it (`Visit.pass`)."""

    created_at: datetime
    revoked_at: datetime | None
    revoke_reason: str | None


class PassRepository:
    def __init__(self, db: Session) -> None:
        self.db = db

    def add(self, visitor_pass: VisitorPass) -> VisitorPass:
        self.db.add(visitor_pass)
        self.db.flush()
        return visitor_pass

    def find_by_hash(self, company_id: UUID, token_hash: str) -> VisitorPass | None:
        statement = (
            select(VisitorPass)
            .join(Company, Company.id == VisitorPass.company_id)
            .where(
                VisitorPass.company_id == company_id,
                VisitorPass.token_hash == token_hash,
                Company.is_active.is_(True),
            )
        )
        return self.db.scalars(statement).one_or_none()

    def active_for_visit(self, company_id: UUID, visit_id: UUID) -> VisitorPass | None:
        statement = select(VisitorPass).where(
            VisitorPass.company_id == company_id,
            VisitorPass.visit_id == visit_id,
            VisitorPass.revoked_at.is_(None),
        )
        return self.db.scalars(statement).one_or_none()

    def current_for_visits(self, company_id: UUID, visit_ids: Collection[UUID]) -> dict[UUID, CurrentPass]:
        """Each visit's current pass: its active one, otherwise the most recently issued. Only what a
        visit response shows, not entities: a list holds up to hundreds of visits."""
        if not visit_ids:
            return {}
        statement = (
            select(
                VisitorPass.visit_id,
                VisitorPass.created_at,
                VisitorPass.revoked_at,
                VisitorPass.revoke_reason,
            )
            .where(VisitorPass.company_id == company_id, any_of(VisitorPass.visit_id, visit_ids))
            .order_by(
                VisitorPass.visit_id,
                VisitorPass.revoked_at.is_(None).desc(),
                VisitorPass.created_at.desc(),
                VisitorPass.id.desc(),
            )
            .ext(distinct_on(VisitorPass.visit_id))
        )
        return {row[0]: CurrentPass(row[1], row[2], row[3]) for row in self.db.execute(statement)}

    def shift_times(self, company_id: UUID, visit_id: UUID, delta: timedelta) -> None:
        """Non-production maintenance (E2E time travel): move the passes' timestamps with their visit."""
        self.db.execute(
            update(VisitorPass)
            .where(VisitorPass.company_id == company_id, VisitorPass.visit_id == visit_id)
            .values(
                created_at=VisitorPass.created_at + delta,
                revoked_at=VisitorPass.revoked_at + delta,
            )
            .execution_options(synchronize_session=False)
        )
