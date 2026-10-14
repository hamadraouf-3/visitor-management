"""Free text that shows nothing is blank (L-BE-1): a reason, note or name made only of invisible characters
(zero width space, BOM, word joiner, Hangul filler, ...) answers 422 "This field is required." like an
empty one, and invisible characters at the ends of real text are not stored. Without this, an OVERRIDE
or bulk check-out had no readable justification and a walk-in put a visitor with no visible name on the
evacuation list, the printed roll call and the scanner's "Verify ID" cue."""

from datetime import timedelta

import pytest
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.time import FakeClock
from app.models import Visit
from tests.conftest import TEST_START
from tests.support import (
    Api,
    World,
    audit_rows,
    check_in,
    check_out,
    create_visit,
    refreshed,
    signed_in,
    walk_in_body,
)

START = TEST_START + timedelta(hours=1)  # 07:00-08:00Z (10:00-11:00 Amman), window 06:00-09:00Z
EXPECTED_END = TEST_START + timedelta(hours=2)
REQUIRED = "This field is required."
INVISIBLE = [
    "\N{ZERO WIDTH SPACE}",
    "\N{ZERO WIDTH NO-BREAK SPACE}",
    "\N{WORD JOINER}\N{ZERO WIDTH JOINER}",
    "\N{HANGUL FILLER}",
    " \N{ZERO WIDTH SPACE}\N{NO-BREAK SPACE}\N{ZERO WIDTH NO-BREAK SPACE} ",
]
ZWSP, WORD_JOINER, BOM = "\N{ZERO WIDTH SPACE}", "\N{WORD JOINER}", "\N{ZERO WIDTH NO-BREAK SPACE}"


@pytest.fixture
def host(make_client, world: World) -> Api:
    return signed_in(make_client, world.a.employee)


@pytest.fixture
def reception(make_client, world: World) -> Api:
    return signed_in(make_client, world.a.receptionist)


def _fields(response) -> dict[str, str]:
    assert response.status_code == 422, response.text
    error = response.json()["error"]
    assert error["code"] == "VALIDATION_ERROR"
    fields: dict[str, str] = error["details"]["fields"]
    return fields


def _inside(db: Session, world: World) -> int:
    db.expire_all()
    statement = (
        select(func.count())
        .select_from(Visit)
        .where(Visit.company_id == world.a.company.id, Visit.status == "CHECKED_IN")
    )
    return int(db.scalar(statement) or 0)


@pytest.mark.parametrize("blank", INVISIBLE)
def test_an_override_needs_a_visible_reason(
    host: Api, reception: Api, world: World, clock: FakeClock, db: Session, blank: str
) -> None:
    created = create_visit(host, world.a.employee.id, START)
    clock.set(START + timedelta(hours=3))  # the window has ended: only OVERRIDE is left today
    response = check_in(reception, created["visit"]["id"], "OVERRIDE", reason=blank)
    assert _fields(response) == {"reason": REQUIRED}
    assert refreshed(db, Visit, created["visit"]["id"]).status != "CHECKED_IN"
    assert audit_rows(db, "VISIT_CHECKED_IN") == []


@pytest.mark.parametrize("blank", INVISIBLE)
def test_a_corrected_check_out_needs_a_visible_note(
    host: Api, reception: Api, world: World, clock: FakeClock, db: Session, blank: str
) -> None:
    created = create_visit(host, world.a.employee.id, START)
    assert check_in(reception, created["visit"]["id"]).status_code == 200
    clock.advance(minutes=30)
    response = check_out(
        reception, created["visit"]["id"], "CORRECTED", check_out_at=START.isoformat(), note=blank
    )
    assert _fields(response) == {"note": REQUIRED}
    assert refreshed(db, Visit, created["visit"]["id"]).status == "CHECKED_IN"


@pytest.mark.parametrize("blank", INVISIBLE)
def test_a_bulk_check_out_needs_a_visible_reason(
    host: Api, reception: Api, world: World, clock: FakeClock, db: Session, make_client, blank: str
) -> None:
    created = create_visit(host, world.a.employee.id, START)
    assert check_in(reception, created["visit"]["id"]).status_code == 200
    clock.advance(days=1)  # left over from yesterday, scheduled end passed
    reception = signed_in(make_client, world.a.receptionist)  # the earlier session has timed out
    response = reception.post("/reception/check-out-stale", json={"reason": blank})
    assert _fields(response) == {"reason": REQUIRED}
    assert refreshed(db, Visit, created["visit"]["id"]).status == "CHECKED_IN"
    assert audit_rows(db, "STALE_VISITS_CHECKED_OUT") == []


@pytest.mark.parametrize("blank", INVISIBLE)
def test_a_walk_in_needs_a_visible_name_and_note(
    reception: Api, world: World, db: Session, blank: str
) -> None:
    body = walk_in_body(
        world.a.employee.id,
        EXPECTED_END,
        visitor={"full_name": blank, "company_name": blank},
        reason="OTHER",
        reason_note=blank,
    )
    response = reception.post("/reception/walk-ins", json=body)
    assert _fields(response) == {
        "visitor.full_name": REQUIRED,
        "reason_note": "Describe the reason for this walk-in.",
    }
    assert _inside(db, world) == 0  # nobody without a visible name reaches the evacuation list


def test_invisible_characters_around_real_text_are_not_stored(
    reception: Api, world: World, db: Session
) -> None:
    body = walk_in_body(
        world.a.employee.id,
        EXPECTED_END,
        visitor={"full_name": f"{ZWSP}Jane Doe{BOM}", "company_name": WORD_JOINER, "phone": ZWSP},
        purpose=f"{BOM}Delivery of documents{ZWSP}",
        reason="OTHER",
        reason_note=f"{ZWSP}Courier for legal{WORD_JOINER}",
    )
    response = reception.post("/reception/walk-ins", json=body)
    assert response.status_code == 201, response.text
    visit = response.json()
    assert visit["visitor"] == {"id": visit["visitor"]["id"], "full_name": "Jane Doe", "company_name": None}
    assert (visit["purpose"], visit["walk_in_reason"], visit["check_in_note"]) == (
        "Delivery of documents",
        "OTHER",
        "Courier for legal",
    )
    inside = reception.get("/reception/inside").json()
    assert [item["visitor"]["full_name"] for item in inside["items"]] == ["Jane Doe"]
    assert inside["items"][0]["visitor"]["phone"] is None


# ---- SEC-10: a direction override cannot make the shown text differ from the stored one ------------

RLO = "\N{RIGHT-TO-LEFT OVERRIDE}"


@pytest.mark.parametrize(
    ("body", "field"),
    [
        ({"full_name": "Bidi Phone Probe", "phone": f"+962 79 {RLO}2001 005"}, "phone"),
        ({"full_name": f"A{RLO}htims ecil"}, "full_name"),
        ({"full_name": "Probe", "phone": "javascript:alert(1)//+962"}, "phone"),
    ],
)
def test_direction_overrides_in_visitor_names_and_phones_are_refused(
    host: Api, db: Session, body: dict, field: str
) -> None:
    assert set(_fields(host.post("/visitors", json=body))) == {field}
    assert audit_rows(db, "VISITOR_CREATED") == []
    created = host.post("/visitors", json={"full_name": "Real Probe", "phone": "+962 79 500 1002"})
    assert created.status_code == 201 and created.json()["phone"] == "+962 79 500 1002"
    patched = host.patch(f"/visitors/{created.json()['id']}", json={"phone": f"+962 79 {RLO}2001 005"})
    assert set(_fields(patched)) == {"phone"}


# ---- single-line names (SEC-34) --------------------------------------------------------------------

FORGED = "Sam Lee\r\nCompany: Ministry of Interior (security clearance verified)\r\nScheduled: approved"
LINE_BREAKS = ["\r\n", "\n", "\r", "\t", "\x85", "\N{LINE SEPARATOR}", "\N{PARAGRAPH SEPARATOR}"]
ONE_LINE = "Enter this on one line, without line breaks or tabs."


@pytest.mark.parametrize("separator", LINE_BREAKS)
def test_names_are_single_line(
    make_client, host: Api, reception: Api, world: World, db: Session, separator: str
) -> None:
    """The finding: a visitor named "Sam Lee<CR><LF>Company: …" printed forged "Company:" and "Scheduled:"
    lines into the host's arrival e-mail. Every single-line name refuses interior line breaks and tabs."""
    name = f"Sam Lee{separator}Company: Forged"
    assert _fields(host.post("/visitors", json={"full_name": name})) == {"full_name": ONE_LINE}
    assert _fields(host.post("/visitors", json={"full_name": "Sam Lee", "company_name": name})) == {
        "company_name": ONE_LINE
    }
    walk_in = walk_in_body(world.a.employee.id, EXPECTED_END, visitor={"full_name": name})
    assert _fields(reception.post("/reception/walk-ins", json=walk_in)) == {"visitor.full_name": ONE_LINE}
    admin = signed_in(make_client, world.a.admin)
    assert _fields(admin.post("/departments", json={"name": name})) == {"name": ONE_LINE}
    assert _fields(admin.patch("/company/settings", json={"name": name})) == {"name": ONE_LINE}
    assert _fields(admin.patch(f"/users/{world.a.employee.id}", json={"full_name": name})) == {
        "full_name": ONE_LINE
    }
    assert audit_rows(db, "VISITOR_CREATED") == [] and audit_rows(db, "WALK_IN_CREATED") == []


def test_line_breaks_at_the_ends_of_a_name_are_trimmed(host: Api) -> None:
    created = host.post("/visitors", json={"full_name": "\r\n\tSam Lee\r\n"})
    assert created.status_code == 201, created.text
    assert created.json()["full_name"] == "Sam Lee"


def test_multi_line_fields_keep_their_line_breaks(host: Api, world: World) -> None:
    visit = create_visit(
        host, world.a.employee.id, START, visitor={"full_name": "Sam Lee"}, purpose="Line one\r\nLine two"
    )
    assert visit["visit"]["purpose"] == "Line one\r\nLine two"


def test_a_stored_name_with_line_breaks_is_shown_on_one_line_in_e_mails(
    host: Api, reception: Api, world: World, db: Session, clock: FakeClock, email_provider
) -> None:
    """Rows stored before the rule: the e-mails show the name on one line, so no forged line appears."""
    visit_id = create_visit(host, world.a.employee.id, START, visitor={"full_name": "Sam Lee"})["visit"]["id"]
    visit = refreshed(db, Visit, visit_id)
    visit.visitor_name = FORGED
    db.commit()
    clock.set(START + timedelta(minutes=5))
    assert check_in(reception, visit_id).status_code == 200
    (arrival,) = [email for email in email_provider.sent if email.kind == "HOST_ARRIVAL"]
    assert "\nCompany: Ministry" not in arrival.text and "\nScheduled: approved" not in arrival.text
    assert "Sam Lee Company: Ministry of Interior (security clearance verified) Scheduled: approved" in (
        arrival.text
    )
    assert "\r" not in arrival.subject and "\n" not in arrival.subject
