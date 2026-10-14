"""Field codes through the API (Phase 10, B10-18): every 422 VALIDATION_ERROR carries `details.field_codes`
for exactly the paths of `details.fields`, from the schemas and from the services' own rules alike."""

import uuid
from datetime import timedelta
from typing import Any

import httpx

from tests.conftest import TEST_START
from tests.support import DEFAULT_PASSWORD, World, signed_in, visit_body, walk_in_body


def _codes(response: httpx.Response) -> dict[str, Any]:
    assert response.status_code == 422, response.text
    error = response.json()["error"]
    assert error["code"] == "VALIDATION_ERROR"
    details = error["details"]
    assert set(details) == {"fields", "field_codes"}
    assert set(details["field_codes"]) == set(details["fields"])
    return dict(details["field_codes"])


def test_schema_problems_carry_codes_and_limits(make_client, world: World) -> None:
    api = signed_in(make_client, world.a.employee)
    start = TEST_START + timedelta(hours=1)
    body = visit_body(world.a.employee.id, start, purpose="x" * 501, colour="teal")
    body["visitor"] = {"full_name": "Dana\nCompany: Evil", "email": "dana", "phone": "call me"}
    codes = _codes(api.post("/visits", json=body))
    assert codes == {
        "purpose": {"code": "too_long", "params": {"max": 500}},
        "colour": {"code": "not_allowed", "params": {}},
        "visitor.full_name": {"code": "line_breaks", "params": {}},
        "visitor.email": {"code": "invalid_email", "params": {}},
        "visitor.phone": {"code": "invalid_phone", "params": {}},
    }


def test_the_visit_rules_of_the_service_carry_codes(make_client, world: World) -> None:
    api = signed_in(make_client, world.a.employee)
    start = TEST_START + timedelta(hours=1)
    body = visit_body(world.a.employee.id, start, minutes=-30, department_id=str(world.a.legacy.id))
    assert _codes(api.post("/visits", json=body)) == {
        "scheduled_end": {"code": "end_not_after_start", "params": {}},
        "department_id": {"code": "department_inactive", "params": {}},
    }
    too_long = visit_body(world.a.employee.id, start, minutes=25 * 60)
    assert _codes(api.post("/visits", json=too_long)) == {
        "scheduled_end": {"code": "visit_too_long", "params": {"max_hours": 24}}
    }
    far = visit_body(world.a.employee.id, TEST_START + timedelta(days=400))
    assert _codes(api.post("/visits", json=far)) == {
        "scheduled_start": {"code": "too_far_ahead", "params": {"max_days": 365}}
    }
    # An employee invites only as the host (B10-24); an administrator may name another host, which must be
    # an active host of the company.
    colleague_host = visit_body(world.a.admin.id, start)
    assert _codes(api.post("/visits", json=colleague_host)) == {
        "host_id": {"code": "host_must_be_self", "params": {}}
    }
    admin = signed_in(make_client, world.a.admin)
    unknown_host = visit_body(uuid.uuid4(), start)
    assert _codes(admin.post("/visits", json=unknown_host)) == {
        "host_id": {"code": "not_found", "params": {}}
    }
    receptionist_host = visit_body(world.a.receptionist.id, start)
    assert _codes(admin.post("/visits", json=receptionist_host)) == {
        "host_id": {"code": "host_unavailable", "params": {}}
    }


def test_a_walk_in_s_expected_end_carries_its_code(make_client, world: World) -> None:
    reception = signed_in(make_client, world.a.receptionist)
    body = walk_in_body(world.a.employee.id, TEST_START - timedelta(minutes=5))
    assert _codes(reception.post("/reception/walk-ins", json=body)) == {
        "expected_end": {"code": "expected_end_in_past", "params": {}}
    }


def test_password_rules_carry_codes(make_client, world: World) -> None:
    admin = signed_in(make_client, world.a.admin)
    user = {"full_name": "New Person", "email": "new.person@example.com", "roles": ["EMPLOYEE"]}
    short = admin.post("/users", json={**user, "temporary_password": "Elevenchars"})
    assert _codes(short) == {"temporary_password": {"code": "too_short", "params": {"min": 12}}}
    assert short.json()["error"]["details"]["fields"]["temporary_password"] == (
        "Password must be at least 12 characters."
    )
    common = admin.post("/users", json={**user, "temporary_password": "Password1234"})
    assert _codes(common) == {"temporary_password": {"code": "password_common", "params": {}}}
    same = admin.post(
        "/auth/change-password", json={"current_password": DEFAULT_PASSWORD, "new_password": DEFAULT_PASSWORD}
    )
    assert _codes(same) == {"new_password": {"code": "password_unchanged", "params": {}}}


def test_company_settings_and_preferences_carry_codes(make_client, world: World) -> None:
    admin = signed_in(make_client, world.a.admin)
    timezone = admin.patch("/company/settings", json={"timezone": "Mars/Olympus_Mons"})
    assert _codes(timezone) == {"timezone": {"code": "invalid_timezone", "params": {}}}
    language = admin.patch("/auth/preferences", json={"language": "fr"})
    assert _codes(language) == {"language": {"code": "invalid_choice", "params": {"choices": ["ar", "en"]}}}


def test_query_problems_carry_codes(make_client, world: World) -> None:
    admin = signed_in(make_client, world.a.admin)
    report = admin.get("/reports/summary", params={"date_from": "2025-01-01", "date_to": "2026-01-02"})
    assert _codes(report) == {"date_to": {"code": "range_too_long", "params": {"max_days": 366}}}
    visits = admin.get("/visits", params={"date_from": "2026-10-05", "date_to": "2026-10-04", "page": 0})
    assert _codes(visits) == {
        "page": {"code": "too_small", "params": {"min": 1}},
        "date_to": {"code": "end_before_start", "params": {}},
    }
    invalid_json = admin.post(
        "/departments", content=b"{not json", headers={"Content-Type": "application/json"}
    )
    assert _codes(invalid_json) == {"body": {"code": "invalid_json", "params": {}}}
