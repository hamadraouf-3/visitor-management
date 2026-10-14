"""GET /reports/summary (contract §8.1 `ReportSummary`) against a hand-computed fixture.

The company is in Asia/Amman (UTC+3, no DST). The report covers 4-6 October (company-local), i.e. the
UTC instants [3 Oct 21:00, 6 Oct 21:00). Visits sit on both sides of local midnights so the day and hour
bucketing in the company's timezone is pinned (a UTC grouping would put V1 on 3 October and V3/V4 on
the wrong days). The clock stands at 5 October 06:00Z, so the two SCHEDULED visits are still open.

| visit | start (local)        | status / method        | host | dept    | visitor | in (h) |
|-------|----------------------|------------------------|------|---------|---------|--------|
| V1    | 4 Oct 00:30          | CHECKED_OUT MANUAL 1 h | H1   | Finance | X       | 0      |
| V2    | 3 Oct 23:30 (out)    | CHECKED_OUT            | H1   | Finance | X       | -      |
| V3    | 4 Oct 23:45          | CHECKED_IN             | H1   | -       | Y       | 23     |
| V4    | 5 Oct 00:15          | NO_SHOW                | H2   | Finance | Z       | -      |
| V5    | 5 Oct 06:00          | CHECKED_OUT CORRECTED  | H2   | IT      | X       | 6      |
| V6    | 5 Oct 11:00          | CANCELLED              | H1   | IT      | W       | -      |
| V7    | 4 Oct 12:00 walk-in  | CHECKED_OUT MANUAL 30m | H1   | Finance | V       | 12     |
| V8    | 6 Oct 11:00          | SCHEDULED              | H2   | IT      | X       | -      |
| V9    | 6 Oct 23:59          | SCHEDULED              | H3   | -       | U       | -      |
| V10   | 7 Oct 00:00 (out)    | SCHEDULED              | H1   | -       | U       | -      |
| V11   | 4 Oct 08:00          | CHECKED_OUT BULK       | H2   | Finance | T       | 8      |
| B1    | 5 Oct 10:00 (comp B) | CHECKED_OUT            | -    | -       | -       | -      |

Hand-computed: 9 visits (V1, V3-V9, V11); checked in 5 (V1, V3, V5, V7, V11) by 4 distinct visitors
(X twice); 4 checked out; 1 no-show; 1 cancelled; 1 walk-in. No-show rate 1 / 7 (every status but
SCHEDULED). Average duration (3600 + 1800) / 2 = 2700 s (CORRECTED and BULK left out). Per day 4, 3, 2.
Departments: Finance 4, IT 3 (with its Arabic name), none 2. Hosts: H1 4 and H2 4 (by name), H3 1.
"""

from datetime import UTC, date, datetime, timedelta

import pytest
from sqlalchemy.orm import Session

from app.core.time import FakeClock
from app.models import Company, Department, Role, User, Visit, Visitor
from tests.support import Factory, World, create_visit, error_code, signed_in, unique


def _at(day: int, hour: int, minute: int = 0) -> datetime:
    return datetime(2026, 10, day, hour, minute, tzinfo=UTC)


def _visitor(db: Session, company: Company, name: str) -> Visitor:
    visitor = Visitor(company_id=company.id, full_name=name, search_text=name.lower(), name_sort=name.lower())
    db.add(visitor)
    db.flush()
    return visitor


def _visit(
    db: Session,
    company: Company,
    visitor: Visitor,
    host: User,
    start: datetime,
    status: str,
    *,
    department: Department | None = None,
    check_in: datetime | None = None,
    duration: timedelta | None = None,
    out_method: str = "MANUAL",
    walk_in: bool = False,
) -> Visit:
    visit = Visit(
        company_id=company.id,
        visitor_id=visitor.id,
        host_id=host.id,
        created_by_id=host.id,
        department_id=department.id if department else None,
        purpose="Report fixture",
        scheduled_start=start,
        scheduled_end=start + timedelta(hours=1),
        window_start=start - timedelta(hours=1),
        window_end=start + timedelta(hours=2),
        status=status,
        visitor_name=visitor.full_name,
        host_name=host.full_name,
        department_name=department.name if department else None,
        is_walk_in=walk_in,
        walk_in_reason="NO_INVITATION" if walk_in else None,
    )
    if check_in is not None:
        visit.check_in_at, visit.checked_in_by_id = check_in, host.id
        visit.check_in_method = "WALK_IN" if walk_in else "MANUAL"
    if duration is not None and check_in is not None:
        visit.check_out_at, visit.checked_out_by_id = check_in + duration, host.id
        visit.check_out_method = out_method
        visit.check_out_note = "fixture" if out_method in ("CORRECTED", "BULK") else None
    if status == "CANCELLED":
        visit.cancelled_at = _at(5, 5)
    if status == "NO_SHOW":
        visit.no_show_at = _at(5, 1)
    db.add(visit)
    return visit


@pytest.fixture
def fixture(world: World, factory: Factory, db: Session) -> dict:
    company = world.a.company
    h1 = world.a.employee  # "Alpha Employee"
    h2 = factory.user(company, roles=(Role.EMPLOYEE,), full_name="Basil Host")
    h3 = factory.user(company, roles=(Role.EMPLOYEE,), full_name="Carla Host")
    finance, it = world.a.finance, factory.department(company, unique("IT"), name_ar="تقنية المعلومات")
    x, y, z, w, v, t, u = (_visitor(db, company, name) for name in ("X", "Y", "Z", "W", "V", "T", "U"))
    hour = timedelta(hours=1)
    _visit(
        db,
        company,
        x,
        h1,
        _at(3, 21, 30),
        "CHECKED_OUT",
        department=finance,
        check_in=_at(3, 21, 35),
        duration=hour,
    )
    _visit(
        db,
        company,
        x,
        h1,
        _at(3, 20, 30),
        "CHECKED_OUT",
        department=finance,
        check_in=_at(3, 20, 35),
        duration=hour,
    )
    _visit(db, company, y, h1, _at(4, 20, 45), "CHECKED_IN", check_in=_at(4, 20, 50))
    _visit(db, company, z, h2, _at(4, 21, 15), "NO_SHOW", department=finance)
    _visit(
        db, company, x, h2, _at(5, 3), "CHECKED_OUT", department=it, check_in=_at(5, 3, 5),
        duration=2 * hour, out_method="CORRECTED",
    )  # fmt: skip
    _visit(db, company, w, h1, _at(5, 8), "CANCELLED", department=it)
    _visit(
        db, company, v, h1, _at(4, 9), "CHECKED_OUT", department=finance, check_in=_at(4, 9),
        duration=timedelta(minutes=30), walk_in=True,
    )  # fmt: skip
    _visit(db, company, x, h2, _at(6, 8), "SCHEDULED", department=it)
    _visit(db, company, u, h3, _at(6, 20, 59), "SCHEDULED")
    _visit(db, company, u, h1, _at(6, 21), "SCHEDULED")
    _visit(
        db, company, t, h2, _at(4, 5), "CHECKED_OUT", department=finance, check_in=_at(4, 5),
        duration=hour, out_method="BULK",
    )  # fmt: skip
    other = world.b
    _visit(
        db, other.company, _visitor(db, other.company, "B1"), other.employee, _at(5, 7), "CHECKED_OUT",
        check_in=_at(5, 7), duration=hour,
    )  # fmt: skip
    db.commit()
    return {"h1": h1, "h2": h2, "h3": h3, "finance": finance, "it": it}


def _summary(make_client, user: User, **params):
    return signed_in(make_client, user).get("/reports/summary", params=params)


def test_report_matches_the_hand_computed_fixture(make_client, world: World, fixture: dict) -> None:
    response = _summary(make_client, world.a.manager, date_from="2026-10-04", date_to="2026-10-06")
    assert response.status_code == 200, response.text
    report = response.json()
    assert (report["date_from"], report["date_to"], report["timezone"]) == (
        "2026-10-04",
        "2026-10-06",
        "Asia/Amman",
    )
    assert report["totals"] == {
        "visits": 9,
        "unique_visitors": 4,
        "checked_in": 5,
        "checked_out": 4,
        "no_show": 1,
        "cancelled": 1,
        "walk_ins": 1,
    }
    assert report["no_show_rate"] == pytest.approx(1 / 7)
    assert report["avg_duration_seconds"] == 2700.0
    assert report["visits_per_day"] == [
        {"date": "2026-10-04", "count": 4},
        {"date": "2026-10-05", "count": 3},
        {"date": "2026-10-06", "count": 2},
    ]
    # Under each department's current names in both languages (B10-25).
    assert report["by_department"] == [
        {"department_id": str(fixture["finance"].id), "name": "Finance", "name_ar": None, "count": 4},
        {
            "department_id": str(fixture["it"].id),
            "name": fixture["it"].name,
            "name_ar": "تقنية المعلومات",
            "count": 3,
        },
        {"department_id": None, "name": "No department", "name_ar": None, "count": 2},
    ]
    assert report["top_hosts"] == [
        {"host_id": str(fixture["h1"].id), "full_name": "Alpha Employee", "count": 4},
        {"host_id": str(fixture["h2"].id), "full_name": "Basil Host", "count": 4},
        {"host_id": str(fixture["h3"].id), "full_name": "Carla Host", "count": 1},
    ]
    hours = {entry["hour"]: entry["count"] for entry in report["check_ins_by_hour"]}
    assert [entry["hour"] for entry in report["check_ins_by_hour"]] == list(range(24))
    assert {hour: count for hour, count in hours.items() if count} == {0: 1, 6: 1, 8: 1, 12: 1, 23: 1}
    assert sum(hours.values()) == report["totals"]["checked_in"]


def test_days_without_visits_are_filled_with_zero(make_client, world: World, fixture: dict) -> None:
    report = _summary(make_client, world.a.admin, date_from="2026-10-01", date_to="2026-10-07").json()
    assert [entry["count"] for entry in report["visits_per_day"]] == [
        0,
        0,
        1,
        4,
        3,
        2,
        1,
    ]  # V2 on the 3rd, V10 on the 7th
    assert report["totals"]["visits"] == 11


def test_an_empty_range_has_no_rates(make_client, world: World) -> None:
    report = _summary(make_client, world.a.manager, date_from="2026-09-01", date_to="2026-09-02").json()
    assert report["totals"]["visits"] == 0
    assert report["no_show_rate"] is None and report["avg_duration_seconds"] is None
    assert report["by_department"] == [] and report["top_hosts"] == []
    assert all(entry["count"] == 0 for entry in report["check_ins_by_hour"])


def test_department_and_host_names_are_current(make_client, world: World, fixture: dict) -> None:
    admin = signed_in(make_client, world.a.admin)
    assert (
        admin.patch(f"/departments/{fixture['finance'].id}", json={"name": "Finance & Accounts"}).status_code
        == 200
    )
    report = admin.get("/reports/summary", params={"date_from": "2026-10-04", "date_to": "2026-10-06"}).json()
    assert report["by_department"][0]["name"] == "Finance & Accounts"


def test_default_and_open_ranges(make_client, world: World) -> None:
    # The clock is at 5 October 09:00 in Amman.
    assert _range(_summary(make_client, world.a.manager)) == ("2026-09-06", "2026-10-05")
    assert _range(_summary(make_client, world.a.manager, date_to="2026-08-31")) == (
        "2026-08-02",
        "2026-08-31",
    )
    assert _range(_summary(make_client, world.a.manager, date_from="2026-09-20")) == (
        "2026-09-20",
        "2026-10-05",
    )
    assert _range(_summary(make_client, world.a.manager, date_from="2025-01-01")) == (
        "2025-01-01",
        "2026-01-01",
    )
    assert _range(_summary(make_client, world.a.manager, date_from="2026-12-01")) == (
        "2026-12-01",
        "2026-12-01",
    )


def _range(response) -> tuple[str, str]:
    assert response.status_code == 200, response.text
    body = response.json()
    assert (
        len(body["visits_per_day"])
        == (date.fromisoformat(body["date_to"]) - date.fromisoformat(body["date_from"])).days + 1
    )
    return body["date_from"], body["date_to"]


@pytest.mark.parametrize(
    ("params", "field", "message"),
    [
        (
            {"date_from": "2025-01-01", "date_to": "2026-01-02"},
            "date_to",
            "Choose a range of at most 366 days.",
        ),
        (
            {"date_from": "2026-10-05", "date_to": "2026-10-04"},
            "date_to",
            "The end date must not be before the start date.",
        ),
        ({"date_from": "05/10/2026"}, "date_from", "Enter a valid date (YYYY-MM-DD)."),
        ({"date_from": "2026-10-01", "format": "csv"}, "format", "This field is not allowed."),
    ],
)
def test_invalid_ranges_are_field_errors(
    make_client, world: World, params: dict, field: str, message: str
) -> None:
    response = _summary(make_client, world.a.manager, **params)
    assert response.status_code == 422
    assert response.json()["error"]["details"]["fields"] == {field: message}


def test_a_full_year_including_a_leap_day_is_allowed(make_client, world: World) -> None:
    response = _summary(
        make_client, world.a.manager, date_from="2028-01-01", date_to="2028-12-31"
    )  # 366 days
    assert response.status_code == 200 and len(response.json()["visits_per_day"]) == 366


def test_reports_are_for_management_and_administrators(make_client, world: World) -> None:
    for user in (world.a.manager, world.a.admin):
        assert _summary(make_client, user).status_code == 200
    for user in (world.a.employee, world.a.receptionist):
        response = _summary(make_client, user)
        assert response.status_code == 403 and error_code(response) == "FORBIDDEN"


def test_reports_count_one_company_only(make_client, world: World, fixture: dict) -> None:
    report = _summary(make_client, world.b.admin, date_from="2026-10-04", date_to="2026-10-06").json()
    assert report["totals"]["visits"] == 1 and report["totals"]["checked_out"] == 1


def test_reports_mark_no_shows_first(make_client, world: World, clock: FakeClock) -> None:
    """A SCHEDULED visit whose window ended is counted as the NO_SHOW it is."""
    host = signed_in(make_client, world.a.employee)
    create_visit(host, world.a.employee.id, _at(5, 7))
    clock.set(_at(5, 10))
    report = _summary(make_client, world.a.manager, date_from="2026-10-05", date_to="2026-10-05").json()
    assert report["totals"]["no_show"] == 1 and report["no_show_rate"] == 1.0
