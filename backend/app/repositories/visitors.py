"""Visitor data access, scoped by company and, for EMPLOYEE-only callers, by the visitor read scope of
contract §7.5 (`owner_id`, see `repositories.scope.visitor_readable_by`)."""

import uuid
from collections.abc import Collection
from dataclasses import dataclass
from datetime import datetime
from uuid import UUID

from sqlalchemy import ColumnElement, func, or_, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app.core.text import escape_like
from app.models import Visitor
from app.repositories.ids import any_of
from app.repositories.locking import RowLock, with_lock
from app.repositories.pagination import Page, paginate
from app.repositories.scope import visitor_readable_by

EMAIL_CONSTRAINT = "uq_visitors_company_id_email"


@dataclass(frozen=True, slots=True)
class VisitorContact:
    email: str | None
    phone: str | None


def _in_scope(company_id: UUID, owner_id: UUID | None) -> list[ColumnElement[bool]]:
    conditions: list[ColumnElement[bool]] = [Visitor.company_id == company_id]
    if owner_id is not None:
        conditions.append(visitor_readable_by(owner_id))
    return conditions


class VisitorRepository:
    def __init__(self, db: Session) -> None:
        self.db = db

    def add(self, visitor: Visitor) -> Visitor:
        self.db.add(visitor)
        self.db.flush()
        return visitor

    def insert_unless_email_exists(
        self,
        company_id: UUID,
        *,
        full_name: str,
        email: str,
        phone: str | None,
        phone_digits: str | None,
        company_name: str | None,
        search_text: str,
        name_sort: str,
        created_by_id: UUID,
        owned_by_creator: bool,
        now: datetime,
    ) -> Visitor | None:
        """`INSERT … ON CONFLICT (company_id, email) DO NOTHING` (D-05): the new visitor, or None when the
        company already has a visitor with this e-mail address (also one committed concurrently)."""
        statement = (
            insert(Visitor)
            .values(
                id=uuid.uuid4(),
                company_id=company_id,
                full_name=full_name,
                email=email,
                phone=phone,
                phone_digits=phone_digits,
                company_name=company_name,
                search_text=search_text,
                name_sort=name_sort,
                created_by_id=created_by_id,
                owned_by_creator=owned_by_creator,
                created_at=now,
                updated_at=now,
            )
            .on_conflict_do_nothing(index_elements=[Visitor.company_id, Visitor.email])
            .returning(Visitor.id)
        )
        inserted = self.db.scalars(statement).one_or_none()
        return None if inserted is None else self.get(company_id, inserted)

    def get(
        self,
        company_id: UUID,
        visitor_id: UUID,
        *,
        owner_id: UUID | None = None,
        lock: RowLock | None = None,
    ) -> Visitor | None:
        statement = select(Visitor).where(Visitor.id == visitor_id, *_in_scope(company_id, owner_id))
        return self.db.scalars(with_lock(statement, lock, of=Visitor)).one_or_none()

    def get_by_email(self, company_id: UUID, email: str, *, lock: RowLock | None = None) -> Visitor | None:
        """With a lock, a visitor whose address a concurrent transaction changed while this one waited no
        longer matches: PostgreSQL re-checks the condition on the row it locks, so the result is None."""
        statement = select(Visitor).where(Visitor.company_id == company_id, Visitor.email == email)
        return self.db.scalars(with_lock(statement, lock)).one_or_none()

    def ids_in_scope(self, company_id: UUID, visitor_ids: Collection[UUID], *, owner_id: UUID) -> set[UUID]:
        """Which of `visitor_ids` are in the read scope of the EMPLOYEE-only user `owner_id`."""
        if not visitor_ids:
            return set()
        statement = select(Visitor.id).where(
            Visitor.id.in_(list(visitor_ids)), *_in_scope(company_id, owner_id)
        )
        return set(self.db.scalars(statement))

    def count_in_company(self, company_id: UUID) -> int:
        statement = select(func.count()).select_from(Visitor).where(Visitor.company_id == company_id)
        return int(self.db.scalar(statement) or 0)

    def contacts(self, company_id: UUID, visitor_ids: Collection[UUID]) -> dict[UUID, VisitorContact]:
        """The current e-mail address and phone of each visitor, in one query."""
        if not visitor_ids:
            return {}
        statement = select(Visitor.id, Visitor.email, Visitor.phone).where(
            Visitor.company_id == company_id, any_of(Visitor.id, visitor_ids)
        )
        return {row[0]: VisitorContact(email=row[1], phone=row[2]) for row in self.db.execute(statement)}

    def search(
        self,
        company_id: UUID,
        *,
        owner_id: UUID | None,
        text: str | None,
        phone_digits: str | None,
        page: int,
        page_size: int,
    ) -> Page[Visitor]:
        """`text` is already normalised (`core.search`); `phone_digits` are the query's last nine digits.
        Ordered by the folded name (`name_sort`), then `id`."""
        conditions = _in_scope(company_id, owner_id)
        alternatives: list[ColumnElement[bool]] = []
        if text:
            alternatives.append(Visitor.search_text.ilike(f"%{escape_like(text)}%", escape="\\"))
        if phone_digits:
            alternatives.append(Visitor.phone_digits.like(f"%{phone_digits}%"))
        if alternatives:
            conditions.append(or_(*alternatives))
        statement = select(Visitor).where(*conditions).order_by(Visitor.name_sort, Visitor.id)
        return paginate(self.db, statement, page=page, page_size=page_size)
