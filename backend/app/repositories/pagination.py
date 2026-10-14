from dataclasses import dataclass

from sqlalchemy import Select, func, select, text
from sqlalchemy.orm import Session

# The count of a long list (a company's whole audit trail) reads every matching row, a cheap per-row
# step. PostgreSQL prefers a parallel plan for it from about 80,000 rows, but starting the workers costs
# more than they save: measured on the Windows development cluster, 76-186 ms parallel against 21 ms
# serial for 196,000 audit rows (re-audit round 1). The setting lasts until it is put back right after the
# count (or until the transaction ends, should the count fail and the transaction be rolled back).
_SERIAL_PLAN = text("SET LOCAL max_parallel_workers_per_gather = 0")
_DEFAULT_PLAN = text("SET LOCAL max_parallel_workers_per_gather TO DEFAULT")


@dataclass(frozen=True, slots=True)
class Page[T]:
    items: list[T]
    page: int
    page_size: int
    total: int


def paginate[T](
    db: Session, statement: Select[T], *, page: int, page_size: int, serial_count: bool = False
) -> Page[T]:
    """Run `statement` for one page plus the total count.

    `statement` selects one entity, one row per entity (no join that repeats it), already ordered with a
    unique tie-breaker. The page is read first: when it is not full, it is the last page and the total
    follows from it, so the count (a read of every matching row, e.g. a company's whole audit trail) runs
    only for a full page or a page past the end. With `serial_count`, the count runs without parallel
    workers (see `_SERIAL_PLAN`)."""
    offset = (page - 1) * page_size
    rows = list(db.scalars(statement.limit(page_size).offset(offset)).unique().all())
    if 0 < len(rows) < page_size or (not rows and page == 1):
        total = offset + len(rows)
    else:
        total = _count(db, statement, serial=serial_count)
    return Page(items=rows, page=page, page_size=page_size, total=total)


def _count(db: Session, statement: Select[object], *, serial: bool) -> int:
    count = select(func.count()).select_from(statement.order_by(None).subquery())
    if not serial:
        return db.scalar(count) or 0
    db.execute(_SERIAL_PLAN)
    total = db.scalar(count) or 0
    db.execute(_DEFAULT_PLAN)
    return total
