"""The application clock and company-local calendar helpers.

Business logic never calls `datetime.now()` or SQL `now()`; it calls `now()` here, which tests replace
with a `FakeClock`. All instants are timezone-aware UTC.
"""

import threading
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, date, datetime, time, timedelta, tzinfo
from typing import Protocol
from zoneinfo import ZoneInfo


class Clock(Protocol):
    def now(self) -> datetime: ...


class SystemClock:
    def now(self) -> datetime:
        return datetime.now(UTC)


class FakeClock:
    """Deterministic clock for tests.

    Every reading advances the clock by at least `tick` (1 µs by default) so two readings are never
    equal; this keeps `created_at` ordering and "strictly later" checks meaningful.
    """

    def __init__(self, start: datetime, tick: timedelta = timedelta(microseconds=1)) -> None:
        if start.tzinfo is None:
            raise ValueError("FakeClock needs a timezone-aware start")
        if tick <= timedelta(0):
            raise ValueError("FakeClock tick must be positive")
        self._current = start.astimezone(UTC)
        self._tick = tick
        self._lock = threading.Lock()

    def now(self) -> datetime:
        with self._lock:
            value = self._current
            self._current = value + self._tick
            return value

    def peek(self) -> datetime:
        with self._lock:
            return self._current

    def advance(self, delta: timedelta | None = None, **kwargs: float) -> datetime:
        step = (delta or timedelta(0)) + timedelta(**kwargs)
        if step < timedelta(0):
            raise ValueError("the fake clock never goes backwards")
        with self._lock:
            self._current += step
            return self._current

    def set(self, instant: datetime) -> None:
        if instant.tzinfo is None:
            raise ValueError("instant must be timezone-aware")
        instant = instant.astimezone(UTC)
        with self._lock:
            if instant < self._current:
                raise ValueError("the fake clock never goes backwards")
            self._current = instant


_clock: Clock = SystemClock()


def now() -> datetime:
    """Current instant (aware, UTC) from the active clock."""
    return _clock.now()


def get_clock() -> Clock:
    return _clock


def set_clock(clock: Clock) -> None:
    global _clock  # the process-wide clock is deliberately swappable (tests install a FakeClock)
    _clock = clock


def reset_clock() -> None:
    set_clock(SystemClock())


@contextmanager
def using_clock(clock: Clock) -> Iterator[Clock]:
    previous = _clock
    set_clock(clock)
    try:
        yield clock
    finally:
        set_clock(previous)


def as_zone(tz: str | tzinfo) -> tzinfo:
    return ZoneInfo(tz) if isinstance(tz, str) else tz


def local_date(instant: datetime, tz: str | tzinfo) -> date:
    """The company-local calendar date of an instant."""
    if instant.tzinfo is None:
        raise ValueError("instant must be timezone-aware")
    return instant.astimezone(as_zone(tz)).date()


def company_day_bounds(day: date, tz: str | tzinfo) -> tuple[datetime, datetime]:
    """UTC `[start, end)` of a company-local calendar day.

    Local midnight is built with fold=0: when midnight falls in a DST gap this yields the transition
    instant (the first instant of the day); when midnight is ambiguous it picks the first occurrence.
    The day can therefore be 23 or 25 hours long.
    """
    zone = as_zone(tz)
    start = datetime.combine(day, time(0), tzinfo=zone).astimezone(UTC)
    end = datetime.combine(day + timedelta(days=1), time(0), tzinfo=zone).astimezone(UTC)
    return start, end


def company_date_range_bounds(first: date, last: date, tz: str | tzinfo) -> tuple[datetime, datetime]:
    """UTC `[start, end)` covering the inclusive company-local date range `first..last`."""
    if last < first:
        raise ValueError("last must not be before first")
    return company_day_bounds(first, tz)[0], company_day_bounds(last, tz)[1]


def company_date_filter_bounds(
    first: date | None, last: date | None, tz: str | tzinfo
) -> tuple[datetime | None, datetime | None]:
    """UTC `[start, end)` of an inclusive company-local date filter whose ends may be open (None):
    `start` is the first instant of `first`, `end` the first instant after `last`."""
    start = company_day_bounds(first, tz)[0] if first is not None else None
    end = company_day_bounds(last, tz)[1] if last is not None else None
    return start, end


def to_utc(instant: datetime) -> datetime:
    if instant.tzinfo is None:
        raise ValueError("instant must be timezone-aware")
    return instant.astimezone(UTC)
