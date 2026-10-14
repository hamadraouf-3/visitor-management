"""Seeding a throwaway database with a realistic volume for the performance checks (opt-in).

One company with 200 hosts in 10 departments, `visitors` visitors (about a tenth with Arabic names) and
`visits` visits spread over the 330 days before and the 30 days after `now`: past visits checked out
(some walk-ins, some with corrected times), no-shows and cancellations; future visits mostly scheduled.
On top of that history, the company-local day of `now` is an ordinary busy reception day (`TodayMix`):
visits expected later today, distinct visitors inside, check-outs and no-shows earlier today.

Every invited (non-walk-in) visit has its pass, revoked once the visit was completed or cancelled, and a
few have an earlier pass revoked by a rotation; walk-ins have none. A share of the visitors with an
address received an invitation (a few failed), invited cancelled visits a cancellation notice, and half
of the check-ins notified their host. The audit trail holds each visit's creation, pass, check-in and
check-out in time order. Derived columns are computed with the application's own folding
(`app.core.search`). Rows are written with COPY as the owner role, then the tables are analysed so the
planner sees the real distribution.
"""

import random
import uuid
from collections import Counter
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import UTC, datetime, time, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy import Engine, text

from app.core.search import ascii_digits, name_sort_key, visitor_search_text

FIRST = [
    "James",
    "Mary",
    "John",
    "Patricia",
    "Robert",
    "Jennifer",
    "Michael",
    "Linda",
    "William",
    "Elizabeth",
    "David",
    "Barbara",
    "Richard",
    "Susan",
    "Joseph",
    "Jessica",
    "Thomas",
    "Sarah",
    "Charles",
    "Karen",
    "Daniel",
    "Nancy",
    "Matthew",
    "Lisa",
    "Anthony",
    "Betty",
    "Mark",
    "Margaret",
    "Paul",
    "Sandra",
    "Steven",
    "Ashley",
    "Andrew",
    "Kimberly",
    "Kenneth",
    "Emily",
    "Joshua",
    "Donna",
    "Kevin",
    "Michelle",
    "Brian",
    "Carol",
    "George",
    "Amanda",
    "Edward",
    "Melissa",
    "Ronald",
    "Deborah",
    "Timothy",
    "Stephanie",
    "Omar",
    "Lina",
    "Rami",
    "Dina",
    "Nour",
    "Amal",
    "Sami",
    "Huda",
    "Yousef",
    "Rana",
    "Karim",
    "Leila",
    "Tariq",
    "Salma",
    "Fadi",
    "Maya",
    "Hassan",
    "Rania",
    "Ziad",
    "Noor",
    "Elodie",
    "Zoe",
    "Chloe",
    "Ines",
    "Lea",
    "Manon",
    "Camille",
]
LAST = [
    "Smith",
    "Johnson",
    "Williams",
    "Brown",
    "Jones",
    "Garcia",
    "Miller",
    "Davis",
    "Rodriguez",
    "Martinez",
    "Hernandez",
    "Lopez",
    "Gonzalez",
    "Wilson",
    "Anderson",
    "Thomas",
    "Taylor",
    "Moore",
    "Jackson",
    "Martin",
    "Lee",
    "Perez",
    "Thompson",
    "White",
    "Harris",
    "Sanchez",
    "Clark",
    "Ramirez",
    "Lewis",
    "Robinson",
    "Walker",
    "Young",
    "Allen",
    "King",
    "Wright",
    "Scott",
    "Torres",
    "Nguyen",
    "Hill",
    "Flores",
    "Green",
    "Adams",
    "Nelson",
    "Baker",
    "Hall",
    "Rivera",
    "Campbell",
    "Mitchell",
    "Carter",
    "Roberts",
    "Haddad",
    "Khalil",
    "Saleh",
    "Nasser",
    "Farah",
    "Abbas",
    "Odeh",
    "Mansour",
    "Darwish",
    "Qasem",
    "Hamdan",
    "Masri",
    "Khoury",
    "Najjar",
    "Shami",
    "Halabi",
    "Tamimi",
    "Zoubi",
    "Bakri",
    "Dubois",
    "Moreau",
    "Laurent",
]
ARABIC_FIRST = [
    "محمد",
    "أحمد",
    "علي",
    "عمر",
    "خالد",
    "يوسف",
    "فاطمة",
    "مريم",
    "سارة",
    "ليلى",
    "نور",
    "هدى",
    "إيمان",
    "رنا",
]
ARABIC_LAST = [
    "الحداد",
    "خليل",
    "صالح",
    "ناصر",
    "فرح",
    "عباس",
    "عودة",
    "منصور",
    "درويش",
    "قاسم",
    "المصري",
    "الخوري",
]
# A surname only a few visitors carry: the history search for it must not read the whole company.
RARE_SURNAME = "Quennell"
RARE_SURNAME_INDEXES = frozenset({13, 15, 17})
COMPANIES = [
    "Acme",
    "Globex",
    "Initech",
    "Umbrella",
    "Hooli",
    "Vandelay",
    "Stark",
    "Wayne",
    "Wonka",
    "Cyberdyne",
    "Orbit",
    "Nimbus",
]


@dataclass(frozen=True, slots=True)
class TodayMix:
    """The reception's day at `now` (09:00 company time in the checks): how many visits each list of
    GET /reception/today holds. The default is an ordinary busy day."""

    expected: int = 120  # SCHEDULED, window open, starting later today
    inside: int = 45  # CHECKED_IN today, distinct visitors (a few walk-ins)
    checked_out: int = 70  # checked in and out earlier today
    no_show: int = 15  # scheduled early today, window ended before `now`


@dataclass(frozen=True, slots=True)
class SeededVolume:
    company_id: uuid.UUID
    admin_email: str
    host_email: str
    reception_email: str
    host_id: uuid.UUID
    surname: str  # a common surname, for search
    rare_surname: str  # carried by three visitors
    phone_query: str  # a phone number as reception would type it
    arabic_name: str
    visits: int
    visitors: int
    passes: int
    emails: int
    audit_rows: int
    today: TodayMix
    timezone: str
    history_visitor_id: uuid.UUID  # a visitor with several visits (GET /visitors/{id}/visits)


VISIT_COLUMNS = (
    "id",
    "company_id",
    "visitor_id",
    "host_id",
    "created_by_id",
    "department_id",
    "purpose",
    "scheduled_start",
    "scheduled_end",
    "window_start",
    "window_end",
    "status",
    "invitation_requested",
    "visitor_link_in_scope",
    "visitor_name",
    "visitor_company_name",
    "host_name",
    "department_name",
    "is_walk_in",
    "walk_in_reason",
    "check_in_at",
    "checked_in_by_id",
    "check_in_method",
    "check_in_note",
    "check_out_at",
    "checked_out_by_id",
    "check_out_method",
    "check_out_note",
    "cancelled_at",
    "cancelled_by_id",
    "cancellation_reason",
    "no_show_at",
    "created_at",
    "updated_at",
)
PASS_COLUMNS = (
    "id",
    "company_id",
    "visit_id",
    "token_hash",
    "created_by_id",
    "revoked_at",
    "revoke_reason",
    "created_at",
)
EMAIL_COLUMNS = (
    "id",
    "company_id",
    "visit_id",
    "recipient_user_id",
    "kind",
    "to_email",
    "subject",
    "status",
    "provider",
    "provider_message_id",
    "attempts",
    "last_error",
    "last_attempt_at",
    "sent_at",
    "created_at",
    "updated_at",
)
AUDIT_COLUMNS = (
    "id",
    "company_id",
    "actor_user_id",
    "action",
    "entity_type",
    "entity_id",
    "metadata",
    "created_at",
)

TIMEZONE = "Asia/Amman"
INVITED_SHARE = 0.6  # visits of a visitor with an e-mail address whose host sent an invitation
FAILED_INVITATION_SHARE = 0.05
ROTATED_SHARE = 0.03  # visits whose pass was rotated once (a resend)
HOST_ARRIVAL_SHARE = 0.5  # check-ins that notified the host


@dataclass(frozen=True, slots=True)
class _Context:
    rng: random.Random
    company_id: uuid.UUID
    visitors: list[tuple]
    hosts: list[tuple[uuid.UUID, str, str]]
    departments: list[tuple[uuid.UUID, str]]
    reception_id: uuid.UUID
    now: datetime


def seed_volume(
    owner_engine: Engine,
    *,
    now: datetime,
    password_hash: str,
    visitors: int = 20_000,
    visits: int = 60_000,
    today: TodayMix = TodayMix(),  # noqa: B008 - frozen dataclass
) -> SeededVolume:
    rng = random.Random(20261005)
    company_id = uuid.uuid4()
    departments = [(uuid.uuid4(), f"Department {index:02d}") for index in range(10)]
    hosts = [
        (uuid.uuid4(), f"{rng.choice(FIRST)} {rng.choice(LAST)}", f"host{index}@volume.test")
        for index in range(200)
    ]
    admin_id, reception_id = uuid.uuid4(), uuid.uuid4()
    visitor_rows = []
    for index in range(visitors):
        if index % 10 == 0:
            name = f"{rng.choice(ARABIC_FIRST)} {rng.choice(ARABIC_LAST)}"
        else:
            name = f"{rng.choice(FIRST)} {rng.choice(LAST)}"
        if index in RARE_SURNAME_INDEXES:
            name = f"{name.split()[0]} {RARE_SURNAME}"
        email = f"visitor{index}@example{index % 50}.com" if index % 3 else None
        phone = (
            f"+962 7{rng.randint(7, 9)} {rng.randint(100, 999)} {rng.randint(1000, 9999)}"
            if index % 2
            else None
        )
        company = rng.choice(COMPANIES) if index % 4 else None
        visitor_rows.append(
            (
                uuid.uuid4(),
                name,
                email,
                phone,
                ascii_digits(phone),
                company,
                visitor_search_text(name, email, company),
                name_sort_key(name),
            )
        )
    probe = visitor_rows[1]  # has a phone (odd index) and a Latin name
    context = _Context(rng, company_id, visitor_rows, hosts, departments, reception_id, now)
    day_start, day_end = _company_day(now)

    seeded_visits = [_history_visit(context, day_start, day_end) for _ in range(visits)]
    seeded_visits += _today_visits(context, today, day_start)
    visitor_emails = {row[0]: row[2] for row in visitor_rows}
    host_emails = {host_id: email for host_id, _name, email in hosts}
    passes: list[tuple] = []
    emails: list[tuple] = []
    audit_rows: list[tuple] = []
    for visit in seeded_visits:
        passes += _passes(context, visit)
        emails += _emails(
            context, visit, visitor_emails.get(visit["visitor_id"]), host_emails[visit["host_id"]]
        )
        audit_rows += _audit_rows(context, visit)

    with owner_engine.begin() as connection:
        connection.execute(
            text(
                "INSERT INTO companies (id, name, slug, timezone, created_at, updated_at) "
                "VALUES (:id, 'Volume Co', :slug, :timezone, :now, :now)"
            ),
            {"id": company_id, "slug": f"volume-{company_id.hex[:8]}", "timezone": TIMEZONE, "now": now},
        )
        for department_id, name in departments:
            connection.execute(
                text(
                    "INSERT INTO departments (id, company_id, name, is_active, created_at, updated_at) "
                    "VALUES (:id, :company, :name, true, :now, :now)"
                ),
                {"id": department_id, "company": company_id, "name": name, "now": now},
            )
        staff = [
            (host_id, name, email, ["EMPLOYEE"], departments[i % 10][0])
            for i, (host_id, name, email) in enumerate(hosts)
        ]
        staff += [
            (admin_id, "Volume Admin", "admin@volume.test", ["SYSTEM_ADMIN"], None),
            (reception_id, "Volume Reception", "reception@volume.test", ["RECEPTIONIST"], None),
        ]
        for user_id, name, email, roles, department_id in staff:
            connection.execute(
                text(
                    "INSERT INTO users (id, company_id, full_name, email, password_hash, roles, "
                    "department_id, is_active, must_change_password, created_at, updated_at) VALUES (:id, "
                    ":company, :name, :email, :hash, CAST(:roles AS text[]), :department, true, false, :now, "
                    ":now)"
                ),
                {
                    "id": user_id,
                    "company": company_id,
                    "name": name,
                    "email": email,
                    "hash": password_hash,
                    "roles": "{" + ",".join(roles) + "}",
                    "department": department_id,
                    "now": now,
                },
            )
        raw = connection.connection.dbapi_connection
        assert raw is not None
        with raw.cursor() as cursor:
            with cursor.copy(
                "COPY visitors (id, company_id, full_name, email, phone, phone_digits, company_name, "
                "search_text, name_sort, created_at, updated_at) FROM STDIN"
            ) as copy:
                for row in visitor_rows:
                    copy.write_row((row[0], company_id, *row[1:], now, now))
            _copy(
                cursor, "visits", VISIT_COLUMNS, (tuple(v[c] for c in VISIT_COLUMNS) for v in seeded_visits)
            )
            _copy(cursor, "visitor_passes", PASS_COLUMNS, passes)
            _copy(cursor, "email_messages", EMAIL_COLUMNS, emails)
            # In time order, as the application appends them (`seq` follows `created_at`).
            _copy(cursor, "audit_logs", AUDIT_COLUMNS, sorted(audit_rows, key=lambda row: row[7]))
    with owner_engine.connect().execution_options(isolation_level="AUTOCOMMIT") as connection:
        connection.execute(text("VACUUM ANALYZE"))
    return SeededVolume(
        company_id=company_id,
        admin_email="admin@volume.test",
        host_email=hosts[0][2],
        reception_email="reception@volume.test",
        host_id=hosts[0][0],
        surname=probe[1].split()[1],
        rare_surname=RARE_SURNAME,
        phone_query="0" + (probe[4] or "")[-9:],
        arabic_name=visitor_rows[0][1].split()[1],
        visits=len(seeded_visits),
        visitors=visitors,
        passes=len(passes),
        emails=len(emails),
        audit_rows=len(audit_rows),
        today=today,
        timezone=TIMEZONE,
        history_visitor_id=Counter(visit["visitor_id"] for visit in seeded_visits).most_common(1)[0][0],
    )


def _copy(cursor: Any, table: str, columns: tuple[str, ...], rows: Iterable[tuple]) -> None:
    with cursor.copy(f"COPY {table} ({', '.join(columns)}) FROM STDIN") as copy:
        for row in rows:
            copy.write_row(row)


def _company_day(now: datetime) -> tuple[datetime, datetime]:
    """The company-local calendar day of `now`, as UTC instants."""
    local = now.astimezone(ZoneInfo(TIMEZONE))
    start = datetime.combine(local.date(), time(0), tzinfo=ZoneInfo(TIMEZONE))
    return start.astimezone(UTC), (start + timedelta(days=1)).astimezone(UTC)


def _base_visit(
    context: _Context, *, visitor: tuple, start: datetime, end: datetime, created: datetime
) -> dict[str, Any]:
    host_id, host_name, _email = context.rng.choice(context.hosts)
    department_id, department_name = context.rng.choice(context.departments)
    return {
        "id": uuid.uuid4(),
        "company_id": context.company_id,
        "visitor_id": visitor[0],
        "host_id": host_id,
        "created_by_id": host_id,
        "department_id": department_id,
        "purpose": "Meeting",
        "scheduled_start": start,
        "scheduled_end": end,
        "window_start": start - timedelta(hours=1),
        "window_end": end + timedelta(hours=1),
        "status": "SCHEDULED",
        "invitation_requested": False,
        "visitor_link_in_scope": True,
        "visitor_name": visitor[1],
        "visitor_company_name": visitor[5],
        "host_name": host_name,
        "department_name": department_name,
        "is_walk_in": False,
        "walk_in_reason": None,
        "check_in_at": None,
        "checked_in_by_id": None,
        "check_in_method": None,
        "check_in_note": None,
        "check_out_at": None,
        "checked_out_by_id": None,
        "check_out_method": None,
        "check_out_note": None,
        "cancelled_at": None,
        "cancelled_by_id": None,
        "cancellation_reason": None,
        "no_show_at": None,
        "created_at": created,
        "updated_at": created,
    }


def _check_in(context: _Context, visit: dict[str, Any], at: datetime, *, walk_in: bool = False) -> None:
    visit["status"] = "CHECKED_IN"
    visit["check_in_at"] = at
    visit["checked_in_by_id"] = context.reception_id
    visit["check_in_method"] = "WALK_IN" if walk_in else context.rng.choice(("QR", "QR", "MANUAL"))
    visit["updated_at"] = at
    if walk_in:
        visit["is_walk_in"] = True
        visit["walk_in_reason"] = "NO_INVITATION"
        visit["created_by_id"] = context.reception_id
        visit["created_at"] = at


def _check_out(context: _Context, visit: dict[str, Any], at: datetime) -> None:
    method = context.rng.choice(("QR", "MANUAL", "MANUAL", "CORRECTED"))
    visit["status"] = "CHECKED_OUT"
    visit["check_out_at"] = at
    visit["checked_out_by_id"] = context.reception_id
    visit["check_out_method"] = method
    visit["check_out_note"] = "Corrected" if method == "CORRECTED" else None
    visit["updated_at"] = at


def _history_visit(context: _Context, day_start: datetime, day_end: datetime) -> dict[str, Any]:
    """A visit of the 330 days before or the 30 days after `now`, outside the company-local today (the
    today mix is seeded explicitly)."""
    rng, now = context.rng, context.now
    visitor = rng.choice(context.visitors)
    day = now.replace(hour=5, minute=0, second=0, microsecond=0) + timedelta(days=rng.randint(-330, 30))
    start = day + timedelta(minutes=30 * rng.randint(0, 20))
    if day_start - timedelta(days=1) < start < day_end:
        start -= timedelta(days=2)  # nothing open today but the today mix
    end = start + timedelta(minutes=rng.choice((30, 60, 90, 120)))
    created = min(start, now) - timedelta(days=rng.randint(1, 14))
    visit = _base_visit(context, visitor=visitor, start=start, end=end, created=created)
    roll = rng.random()
    if visit["window_end"] < now:
        if roll < 0.70:
            walk_in = rng.random() < 0.05
            _check_in(context, visit, start + timedelta(minutes=rng.randint(0, 15)), walk_in=walk_in)
            _check_out(context, visit, visit["check_in_at"] + timedelta(minutes=rng.randint(15, 120)))
        elif roll < 0.85:
            visit["status"], visit["no_show_at"] = "NO_SHOW", visit["window_end"] + timedelta(minutes=1)
        else:
            visit["status"], visit["cancelled_at"] = "CANCELLED", start - timedelta(days=1)
            visit["cancelled_by_id"] = visit["host_id"]
    elif roll < 0.10:
        visit["status"], visit["cancelled_at"] = "CANCELLED", now - timedelta(hours=1)
        visit["cancelled_by_id"] = visit["host_id"]
    return visit


def _today_visits(context: _Context, mix: TodayMix, day_start: datetime) -> list[dict[str, Any]]:
    """The reception's day: `mix.inside` distinct visitors inside, check-outs and no-shows earlier
    today, and expected visits from 15 minutes after `now` to the evening (`now` is 09:00 local)."""
    rng, now = context.rng, context.now
    visitors = rng.sample(context.visitors, mix.inside)
    visits: list[dict[str, Any]] = []

    def at(minutes: int) -> datetime:  # minutes after local midnight
        return day_start + timedelta(minutes=minutes)

    for _ in range(mix.no_show):
        start = at(rng.randint(5 * 60, 6 * 60 + 30))
        visit = _base_visit(
            context,
            visitor=rng.choice(context.visitors),
            start=start,
            end=start + timedelta(minutes=30),
            created=start - timedelta(days=rng.randint(1, 7)),
        )
        visit["status"], visit["no_show_at"] = "NO_SHOW", visit["window_end"] + timedelta(minutes=1)
        visits.append(visit)
    for _ in range(mix.checked_out):
        start = at(rng.randint(6 * 60, 8 * 60))
        visit = _base_visit(
            context,
            visitor=rng.choice(context.visitors),
            start=start,
            end=start + timedelta(minutes=30),
            created=start - timedelta(days=rng.randint(1, 7)),
        )
        check_in = start + timedelta(minutes=rng.randint(0, 10))
        _check_in(context, visit, check_in, walk_in=rng.random() < 0.1)
        _check_out(context, visit, min(check_in + timedelta(minutes=rng.randint(15, 40)), now))
        visits.append(visit)
    for index, visitor in enumerate(visitors):
        start = at(rng.randint(7 * 60, 8 * 60 + 50))
        visit = _base_visit(
            context,
            visitor=visitor,
            start=start,
            end=start + timedelta(minutes=rng.choice((60, 90, 120))),
            created=start - timedelta(days=rng.randint(1, 7)),
        )
        _check_in(
            context, visit, min(start + timedelta(minutes=rng.randint(0, 5)), now), walk_in=index % 9 == 0
        )
        visits.append(visit)
    for _ in range(mix.expected):
        start = now + timedelta(minutes=15 + 5 * rng.randint(0, 130))  # until 20:05 local
        visits.append(
            _base_visit(
                context,
                visitor=rng.choice(context.visitors),
                start=start,
                end=start + timedelta(minutes=rng.choice((30, 60, 90))),
                created=now - timedelta(days=rng.randint(1, 7)),
            )
        )
    return visits


def _token_hash(rng: random.Random) -> str:
    return f"{rng.getrandbits(256):064x}"


def _passes(context: _Context, visit: dict[str, Any]) -> list[tuple]:
    """One pass per invited (non-walk-in) visit, revoked when the visit was completed or cancelled; a
    few visits also have an earlier pass revoked by a rotation (a resend)."""
    if visit["is_walk_in"]:
        return []
    rng = context.rng
    issued = visit["created_at"]
    rows = []
    if rng.random() < ROTATED_SHARE:
        rotated_at = issued + timedelta(hours=1)
        rows.append(
            (
                uuid.uuid4(),
                context.company_id,
                visit["id"],
                _token_hash(rng),
                visit["host_id"],
                rotated_at,
                "ROTATED",
                issued,
            )
        )
        issued = rotated_at
    revoked_at, reason = None, None
    if visit["status"] == "CHECKED_OUT":
        revoked_at, reason = visit["check_out_at"], "VISIT_COMPLETED"
    elif visit["status"] == "CANCELLED":
        revoked_at, reason = visit["cancelled_at"], "VISIT_CANCELLED"
    rows.append(
        (
            uuid.uuid4(),
            context.company_id,
            visit["id"],
            _token_hash(rng),
            visit["host_id"],
            revoked_at,
            reason,
            issued,
        )
    )
    return rows


def _email(
    context: _Context,
    visit: dict[str, Any],
    *,
    kind: str,
    to: str,
    at: datetime,
    failed: bool = False,
    recipient_user_id: uuid.UUID | None = None,
) -> tuple:
    if failed:
        status, attempts, error, sent_at, provider_id = (
            "FAILED",
            3,
            "The email service is unavailable (HTTP 503).",
            None,
            None,
        )
    else:
        status, attempts, error, sent_at, provider_id = "SENT", 1, None, at, str(uuid.uuid4())
    return (
        uuid.uuid4(),
        context.company_id,
        visit["id"],
        recipient_user_id,
        kind,
        to,
        f"Volume {kind.lower()}",
        status,
        "resend",
        provider_id,
        attempts,
        error,
        at,
        sent_at,
        at,
        at,
    )


def _emails(
    context: _Context, visit: dict[str, Any], visitor_email: str | None, host_email: str
) -> list[tuple]:
    """The invitation (for a share of the visitors with an address; a few failed), the cancellation
    notice of an invited visit, and the host-arrival notice of a share of the check-ins."""
    rng = context.rng
    rows = []
    if visitor_email is not None and not visit["is_walk_in"] and rng.random() < INVITED_SHARE:
        visit["invitation_requested"] = True
        failed = visit["status"] == "SCHEDULED" and rng.random() < FAILED_INVITATION_SHARE
        rows.append(
            _email(
                context,
                visit,
                kind="VISITOR_INVITATION",
                to=visitor_email,
                at=visit["created_at"],
                failed=failed,
            )
        )
        if visit["status"] == "CANCELLED":
            rows.append(
                _email(context, visit, kind="VISIT_CANCELLED", to=visitor_email, at=visit["cancelled_at"])
            )
    if visit["check_in_at"] is not None and rng.random() < HOST_ARRIVAL_SHARE:
        rows.append(
            _email(
                context,
                visit,
                kind="HOST_ARRIVAL",
                to=host_email,
                at=visit["check_in_at"],
                recipient_user_id=visit["host_id"],
            )
        )
    return rows


def _audit_rows(context: _Context, visit: dict[str, Any]) -> list[tuple]:
    """What the application records for the visit: its creation and pass, and its check-in and
    check-out."""
    company_id, visit_id = context.company_id, visit["id"]
    rows = [
        (
            uuid.uuid4(),
            company_id,
            visit["created_by_id"],
            "VISIT_CREATED",
            "visit",
            visit_id,
            "{}",
            visit["created_at"],
        ),
    ]
    if not visit["is_walk_in"]:
        rows.append(
            (
                uuid.uuid4(),
                company_id,
                visit["created_by_id"],
                "PASS_ISSUED",
                "pass",
                uuid.uuid4(),
                "{}",
                visit["created_at"],
            )
        )
    if visit["check_in_at"] is not None:
        rows.append(
            (
                uuid.uuid4(),
                company_id,
                context.reception_id,
                "VISIT_CHECKED_IN",
                "visit",
                visit_id,
                "{}",
                visit["check_in_at"],
            )
        )
    if visit["check_out_at"] is not None:
        rows.append(
            (
                uuid.uuid4(),
                company_id,
                context.reception_id,
                "VISIT_CHECKED_OUT",
                "visit",
                visit_id,
                "{}",
                visit["check_out_at"],
            )
        )
    return rows
