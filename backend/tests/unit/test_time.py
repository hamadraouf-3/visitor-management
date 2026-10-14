from datetime import UTC, date, datetime, timedelta
from itertools import pairwise

import pytest

from app.core import time as app_time
from app.core.time import (
    FakeClock,
    SystemClock,
    company_date_range_bounds,
    company_day_bounds,
    local_date,
)


def test_fake_clock_is_strictly_increasing() -> None:
    fake = FakeClock(datetime(2026, 1, 1, tzinfo=UTC))
    readings = [fake.now() for _ in range(1000)]
    assert all(later > earlier for earlier, later in pairwise(readings))
    assert readings[1] - readings[0] == timedelta(microseconds=1)


def test_fake_clock_advance_and_set() -> None:
    fake = FakeClock(datetime(2026, 1, 1, tzinfo=UTC))
    fake.advance(hours=1)
    assert fake.peek() == datetime(2026, 1, 1, 1, tzinfo=UTC)
    fake.set(datetime(2026, 1, 2, tzinfo=UTC))
    with pytest.raises(ValueError, match="backwards"):
        fake.set(datetime(2026, 1, 1, tzinfo=UTC))
    with pytest.raises(ValueError, match="backwards"):
        fake.advance(timedelta(seconds=-1))
    with pytest.raises(ValueError, match="timezone-aware"):
        FakeClock(datetime(2026, 1, 1))


def test_now_uses_the_installed_clock(clock: FakeClock) -> None:
    assert app_time.now() >= clock.peek() - timedelta(microseconds=2)
    with app_time.using_clock(SystemClock()):
        assert app_time.now().tzinfo is UTC
    assert app_time.get_clock() is clock


def test_day_bounds_in_amman() -> None:
    start, end = company_day_bounds(date(2026, 10, 5), "Asia/Amman")
    assert start == datetime(2026, 10, 4, 21, 0, tzinfo=UTC)
    assert end == datetime(2026, 10, 5, 21, 0, tzinfo=UTC)


def test_local_date_around_midnight() -> None:
    just_before = datetime(2026, 10, 5, 20, 59, 59, tzinfo=UTC)  # 23:59:59 in Amman
    midnight = datetime(2026, 10, 5, 21, 0, tzinfo=UTC)  # 00:00 the next day in Amman
    assert local_date(just_before, "Asia/Amman") == date(2026, 10, 5)
    assert local_date(midnight, "Asia/Amman") == date(2026, 10, 6)
    assert local_date(midnight, "UTC") == date(2026, 10, 5)
    start, end = company_day_bounds(date(2026, 10, 6), "Asia/Amman")
    assert start == midnight
    assert start <= midnight < end


def test_day_with_dst_gap_at_midnight_is_23_hours() -> None:
    # Beirut springs forward at 00:00 -> 01:00 on 2026-03-29.
    start, end = company_day_bounds(date(2026, 3, 29), "Asia/Beirut")
    assert start == datetime(2026, 3, 28, 22, 0, tzinfo=UTC)
    assert end - start == timedelta(hours=23)
    assert local_date(start, "Asia/Beirut") == date(2026, 3, 29)
    assert local_date(start - timedelta(microseconds=1), "Asia/Beirut") == date(2026, 3, 28)


def test_day_with_repeated_midnight_hour_is_25_hours() -> None:
    # Havana falls back at 01:00 -> 00:00 on 2026-11-01, so midnight occurs twice.
    start, end = company_day_bounds(date(2026, 11, 1), "America/Havana")
    assert start == datetime(2026, 11, 1, 4, 0, tzinfo=UTC)
    assert end - start == timedelta(hours=25)


def test_date_range_bounds() -> None:
    start, end = company_date_range_bounds(date(2026, 10, 1), date(2026, 10, 3), "Asia/Amman")
    assert end - start == timedelta(days=3)
    with pytest.raises(ValueError, match="before"):
        company_date_range_bounds(date(2026, 10, 3), date(2026, 10, 1), "Asia/Amman")


def test_naive_instants_are_rejected() -> None:
    with pytest.raises(ValueError, match="timezone-aware"):
        local_date(datetime(2026, 1, 1), "UTC")
