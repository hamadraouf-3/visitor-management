"""`paginate` counts the matching rows only when the page does not tell the total (readiness round 1):
the count reads every matching row (a company's whole audit trail on the first audit page), so it is
skipped for the last page, whose total is its offset plus its length. With `serial_count` (the audit
trail, re-audit round 1) the count runs without parallel workers, and the setting is put back after it."""

from typing import Any

import pytest
from sqlalchemy import Select, select

from app.models import AuditLog
from app.repositories.pagination import paginate


class _Result:
    def __init__(self, rows: list[Any]) -> None:
        self.rows = rows

    def unique(self) -> _Result:
        return self

    def all(self) -> list[Any]:
        return self.rows


class _Session:
    """Answers the page from `matching` and records whether the count ran."""

    def __init__(self, matching: int) -> None:
        self.matching = matching
        self.counted = False
        self.executed: list[str] = []

    def scalars(self, statement: Select[Any]) -> _Result:
        limit, offset = statement._limit, statement._offset  # type: ignore[attr-defined]
        return _Result(list(range(self.matching))[offset : offset + limit])

    def scalar(self, statement: Select[Any]) -> int:
        self.counted = True
        self.executed.append("count")
        return self.matching

    def execute(self, statement: Any) -> None:
        self.executed.append(str(statement))


STATEMENT = select(AuditLog).order_by(AuditLog.seq.desc())


@pytest.mark.parametrize(
    ("matching", "page", "items", "total", "counted"),
    [
        (0, 1, 0, 0, False),  # nothing matches: the empty first page says so
        (7, 1, 7, 7, False),  # one partial page
        (57, 3, 7, 57, False),  # the last, partial page: offset 50 + 7
        (50, 2, 25, 50, True),  # a full page: more may follow
        (75, 3, 25, 75, True),  # a full last page: only the count can tell
        (57, 9, 0, 57, True),  # past the end: the count gives the total the client pages by
    ],
)
def test_the_count_runs_only_when_the_page_cannot_tell_the_total(
    matching: int, page: int, items: int, total: int, counted: bool
) -> None:
    db = _Session(matching)
    result = paginate(db, STATEMENT, page=page, page_size=25)  # type: ignore[arg-type]
    assert (len(result.items), result.total, db.counted) == (items, total, counted)
    assert (result.page, result.page_size) == (page, 25)


@pytest.mark.parametrize(("matching", "page"), [(50, 2), (57, 9)])
def test_a_serial_count_runs_without_parallel_workers_and_puts_the_setting_back(
    matching: int, page: int
) -> None:
    db = _Session(matching)
    assert paginate(db, STATEMENT, page=page, page_size=25, serial_count=True).total == matching  # type: ignore[arg-type]
    assert db.executed == [
        "SET LOCAL max_parallel_workers_per_gather = 0",
        "count",
        "SET LOCAL max_parallel_workers_per_gather TO DEFAULT",
    ]


@pytest.mark.parametrize(("serial_count", "matching", "page"), [(False, 50, 2), (True, 7, 1), (True, 0, 1)])
def test_no_setting_is_changed_otherwise(serial_count: bool, matching: int, page: int) -> None:
    db = _Session(matching)
    paginate(db, STATEMENT, page=page, page_size=25, serial_count=serial_count)  # type: ignore[arg-type]
    assert db.executed == (["count"] if db.counted else [])
