"""User data access. Every query except the global e-mail lookup (authentication) is scoped by company."""

from collections.abc import Collection
from dataclasses import dataclass
from uuid import UUID

from sqlalchemy import Text, cast, func, or_, select
from sqlalchemy.dialects.postgresql import ARRAY, array
from sqlalchemy.orm import Session

from app.core.text import escape_like
from app.models import Role, User
from app.repositories.ids import any_of
from app.repositories.locking import RowLock, with_lock
from app.repositories.pagination import Page, paginate
from app.security.permissions import HOST_ROLES, is_available_host


def _text_array(values: Collection[str]) -> object:
    # Array literals are cast explicitly so `&&`/`@>` compare text[] with text[] (contract §4).
    return cast(array(sorted(values), type_=Text), ARRAY(Text))


def _like_pattern(q: str) -> str:
    return f"%{escape_like(q)}%"


@dataclass(frozen=True, slots=True)
class UserSummary:
    """What visit responses show about the users a visit refers to."""

    id: UUID
    full_name: str
    phone: str | None
    is_active: bool
    roles: frozenset[Role]

    @property
    def can_host(self) -> bool:
        return is_available_host(is_active=self.is_active, roles=self.roles)


class UserRepository:
    def __init__(self, db: Session) -> None:
        self.db = db

    def add(self, user: User) -> User:
        self.db.add(user)
        self.db.flush()
        return user

    def get_by_email(self, email: str) -> User | None:
        """Global lookup (e-mail is unique across companies); used only by authentication flows."""
        return self.db.scalars(select(User).where(User.email == email)).one_or_none()

    def get_in_company(self, company_id: UUID, user_id: UUID, *, lock: RowLock | None = None) -> User | None:
        statement = select(User).where(User.company_id == company_id, User.id == user_id)
        # `of=User`: the joined company/department rows are not locked (and cannot be: outer joins).
        return self.db.scalars(with_lock(statement, lock, of=User)).unique().one_or_none()

    def active_email(self, company_id: UUID, user_id: UUID) -> str | None:
        """The user's address while the account is active, else None."""
        statement = select(User.email).where(
            User.company_id == company_id, User.id == user_id, User.is_active.is_(True)
        )
        return self.db.scalars(statement).one_or_none()

    def lock_credentials(self, company_id: UUID, user_id: UUID) -> User | None:
        """Re-read the user under a row lock, refreshing the already loaded object.

        Every credential change (login's session creation, password change, reset, deactivation)
        updates or locks this row first, so they serialise: whoever holds the lock sees the committed
        password hash and activity of everyone before it. `FOR NO KEY UPDATE` is the lock an UPDATE of
        these columns takes anyway; unlike `FOR UPDATE` it does not block the foreign-key checks of rows
        that merely reference the user (e.g. inserting a session).
        """
        statement = (
            select(User)
            .where(User.company_id == company_id, User.id == user_id)
            .with_for_update(of=User, key_share=True)
            .execution_options(populate_existing=True)
        )
        return self.db.scalars(statement).unique().one_or_none()

    def summaries(self, company_id: UUID, user_ids: Collection[UUID]) -> dict[UUID, UserSummary]:
        if not user_ids:
            return {}
        statement = select(User.id, User.full_name, User.phone, User.is_active, User.roles).where(
            User.company_id == company_id, any_of(User.id, user_ids)
        )
        known = {role.value for role in Role}
        return {
            row.id: UserSummary(
                id=row.id,
                full_name=row.full_name,
                phone=row.phone,
                is_active=row.is_active,
                roles=frozenset(Role(value) for value in row.roles if value in known),
            )
            for row in self.db.execute(statement)
        }

    def list_hosts(self, company_id: UUID, *, q: str | None, limit: int) -> list[User]:
        statement = select(User).where(
            User.company_id == company_id,
            User.is_active.is_(True),
            User.roles.overlap(_text_array(HOST_ROLES)),
        )
        if q:
            # Name only: the directory is open to every role and `Host` omits e-mail, so matching on the
            # address would let match/no-match reveal it character by character.
            statement = statement.where(User.full_name.ilike(_like_pattern(q), escape="\\"))
        statement = statement.order_by(func.lower(User.full_name), User.id).limit(limit)
        return list(self.db.scalars(statement).unique())

    def search(
        self,
        company_id: UUID,
        *,
        q: str | None,
        roles: Collection[Role],
        is_active: bool | None,
        page: int,
        page_size: int,
    ) -> Page[User]:
        statement = select(User).where(User.company_id == company_id)
        if q:  # administrators see e-mail addresses anyway
            pattern = _like_pattern(q)
            statement = statement.where(
                or_(User.full_name.ilike(pattern, escape="\\"), User.email.ilike(pattern, escape="\\"))
            )
        if roles:
            statement = statement.where(User.roles.overlap(_text_array(roles)))
        if is_active is not None:
            statement = statement.where(User.is_active.is_(is_active))
        statement = statement.order_by(func.lower(User.full_name), User.id)
        return paginate(self.db, statement, page=page, page_size=page_size)

    def count_active_by_role(self, company_id: UUID) -> dict[Role, int]:
        """Active users holding each role; a user with several roles counts once for each (D-04)."""
        roles = list(Role)
        statement = select(
            *(func.count().filter(User.roles.contains(_text_array([role]))) for role in roles)
        ).where(User.company_id == company_id, User.is_active.is_(True))
        row = self.db.execute(statement).one()
        return {role: int(count or 0) for role, count in zip(roles, row, strict=True)}

    def count_active_admins(self, company_id: UUID, *, excluding: UUID | None = None) -> int:
        statement = (
            select(func.count())
            .select_from(User)
            .where(
                User.company_id == company_id,
                User.is_active.is_(True),
                User.roles.contains(_text_array([Role.SYSTEM_ADMIN])),
            )
        )
        if excluding is not None:
            statement = statement.where(User.id != excluding)
        return self.db.scalar(statement) or 0
