"""Dates and instants beyond the supported range (years 1900-9998) are 422 field errors, never a 500 with a
traceback in the log (B57-61): every role reaches at least one of these endpoints, at the API rate."""

import logging
from datetime import timedelta

import pytest

from app.schemas.common import DATE_OUT_OF_RANGE, DATETIME_OUT_OF_RANGE
from tests.conftest import TEST_START
from tests.support import Api, World, check_in, check_out, create_visit, error_code, signed_in, walk_in_body

START = TEST_START + timedelta(hours=1)


def _field_errors(response) -> dict[str, str]:
    assert response.status_code == 422, response.text
    assert error_code(response) == "VALIDATION_ERROR"
    return response.json()["error"]["details"]["fields"]


@pytest.mark.parametrize(
    ("path", "params", "fields"),
    [
        ("/reports/summary", {"date_to": "9999-12-31"}, {"date_to"}),
        ("/reports/summary", {"date_from": "0001-01-01", "date_to": "0001-01-02"}, {"date_from", "date_to"}),
        ("/audit-logs", {"date_to": "9999-12-31"}, {"date_to"}),
        ("/audit-logs", {"date_from": "0001-01-01"}, {"date_from"}),
        ("/visits", {"scope": "all", "date_to": "9999-12-31"}, {"date_to"}),
    ],
)
def test_date_filters_outside_the_range_are_field_errors(
    make_client, world: World, caplog: pytest.LogCaptureFixture, path: str, params: dict, fields: set[str]
) -> None:
    admin = signed_in(make_client, world.a.admin)
    with caplog.at_level(logging.WARNING):
        response = admin.get(path, params=params)
    assert _field_errors(response) == dict.fromkeys(fields, DATE_OUT_OF_RANGE)
    assert not [record for record in caplog.records if record.levelno >= logging.ERROR or record.exc_info]


def test_the_visit_history_filter_is_checked_for_every_role(make_client, world: World) -> None:
    for user in (world.a.employee, world.a.receptionist, world.a.manager):
        response = signed_in(make_client, user).get("/visits", params={"date_from": "0001-01-01"})
        assert _field_errors(response) == {"date_from": DATE_OUT_OF_RANGE}


def test_a_corrected_check_out_time_outside_the_range_is_a_field_error(
    make_client, world: World, caplog: pytest.LogCaptureFixture
) -> None:
    host = signed_in(make_client, world.a.employee)
    visit_id = create_visit(host, world.a.employee.id, START)["visit"]["id"]
    reception: Api = signed_in(make_client, world.a.receptionist)
    assert check_in(reception, visit_id).status_code == 200
    with caplog.at_level(logging.WARNING):
        response = check_out(
            reception, visit_id, "CORRECTED", check_out_at="0001-01-01T00:00:00+03:00", note="Left early"
        )
    assert _field_errors(response) == {"check_out_at": DATETIME_OUT_OF_RANGE}
    assert not [record for record in caplog.records if record.levelno >= logging.ERROR or record.exc_info]
    assert reception.get(f"/visits/{visit_id}").json()["status"] == "CHECKED_IN"


def test_a_walk_in_expected_end_outside_the_range_is_a_field_error(
    make_client, world: World, caplog: pytest.LogCaptureFixture
) -> None:
    reception = signed_in(make_client, world.a.receptionist)
    body = {**walk_in_body(world.a.employee.id, START), "expected_end": "9999-12-31T23:59:59-05:00"}
    with caplog.at_level(logging.WARNING):
        response = reception.post("/reception/walk-ins", json=body)
    assert _field_errors(response) == {"expected_end": DATETIME_OUT_OF_RANGE}
    assert not [record for record in caplog.records if record.levelno >= logging.ERROR or record.exc_info]
