"""Explicit row locks for `SELECT … FOR …` (PostgreSQL row-level lock modes).

Lock order. Every transaction that changes visits takes its locks in this order, so two of them can
wait for each other but never deadlock:

1. the company row: `FOR KEY SHARE` (visit and visitor changes), `FOR UPDATE` (company settings, user
   changes that affect roles or activity, contract §7.5, and department changes that name a department,
   B10-29);
2. user rows (a host), then the department row, then the visitor row;
3. visit rows, several at a time only in `id` order.

The company's NO_SHOW marking (`no_shows.mark_no_shows_committed`) is committed before step 1, so a
change never holds visit rows it did not ask for while it waits for the locks above.
"""

from enum import StrEnum

from sqlalchemy import Select

from app.db.base import Base


class RowLock(StrEnum):
    # The row cannot be deleted or locked `FOR UPDATE` until this transaction ends. Every change that
    # other rows depend on (deactivating a user, changing roles, renaming, a visitor's e-mail change)
    # holds `FOR UPDATE`, so a reader holding this either sees the committed result of such a change or
    # makes it wait. Ordinary updates (a login stamping `last_login_at`) are not blocked.
    KEY_SHARE = "key_share"
    # Exclusive: the row is about to change, or must not change, until this transaction ends.
    UPDATE = "update"


def with_lock[*Ts](
    statement: Select[*Ts], lock: RowLock | None, *, of: type[Base] | None = None
) -> Select[*Ts]:
    """`statement` locking the rows it returns (of `of` only, for queries that join other tables).

    A locked read always refreshes objects the session already holds: after waiting for another
    transaction, the row this one locked may differ from what it loaded before."""
    if lock is None:
        return statement
    if lock is RowLock.KEY_SHARE:
        statement = statement.with_for_update(of=of, read=True, key_share=True)
    else:
        statement = statement.with_for_update(of=of)
    return statement.execution_options(populate_existing=True)
