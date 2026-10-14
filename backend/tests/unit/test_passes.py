"""Scanner input classification (contract §6 row 1): anything that is not a pass is 404 PASS_INVALID,
audited as PASS_SCANNED{outcome: INVALID}, and never a 422."""

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.core.errors import PassInvalid, register_exception_handlers
from app.schemas.reception import ScanRequest
from app.schemas.visits import CheckInRequest, QrCheckIn
from app.services.passes import invalid_pass, token_from_scanner_input

TOKEN = "Xo3_vK9-aQ2rT7mN4bL8cY1zW6eH5jP0sD-gF_uIk2A"
INVALID_INPUT = [
    "",
    "\t",
    TOKEN + "\x1d",  # the GS separator some handheld scanners append
    "\x00" + TOKEN,
    TOKEN[:31],
    "https://vms.example.com/vms/pass#" + TOKEN,
    "https://vms.example.com/pass#" + "T" * 3000,
    "javascript:alert(1)//pass#" + TOKEN,
]


@pytest.mark.parametrize("raw", [TOKEN, f"  {TOKEN}\r\n", f"https://vms.example.com/pass#{TOKEN}"])
def test_valid_input_yields_the_token(raw: str) -> None:
    assert token_from_scanner_input(raw) == TOKEN


@pytest.mark.parametrize("raw", INVALID_INPUT)
def test_invalid_input_is_pass_invalid(raw: str) -> None:
    with pytest.raises(PassInvalid) as caught:
        token_from_scanner_input(raw)
    assert caught.value.status_code == 404
    assert caught.value.code == "PASS_INVALID"
    assert caught.value.message == "Invalid visitor pass."


def test_invalid_pass_is_the_row_one_error() -> None:
    error = invalid_pass()
    assert isinstance(error, PassInvalid)
    assert error.security_events == ()  # the default PASS_SCANNED{INVALID} event applies


@pytest.fixture
def scan_app() -> FastAPI:
    """The shape Phase 5 routes will have: schema, then the classification helper."""
    app = FastAPI()
    register_exception_handlers(app)
    recorded: list = []
    app.state.security_event_sink = lambda request, event: recorded.append(event)
    app.state.recorded = recorded

    @app.post("/reception/scan")
    def scan(body: ScanRequest) -> dict[str, bool]:
        token_from_scanner_input(body.token)
        return {"parsed": True}

    @app.post("/visits/check-in")
    def check_in(body: CheckInRequest) -> dict[str, bool]:
        if isinstance(body, QrCheckIn):
            token_from_scanner_input(body.pass_token)
        return {"parsed": True}

    return app


@pytest.mark.parametrize("raw", INVALID_INPUT)
def test_malformed_scans_answer_pass_invalid_and_are_audited(scan_app: FastAPI, raw: str) -> None:
    client = TestClient(scan_app)
    for response in (
        client.post("/reception/scan", json={"token": raw}),
        client.post("/visits/check-in", json={"method": "QR", "pass_token": raw}),
    ):
        assert response.status_code == 404
        assert response.json()["error"] == {
            "code": "PASS_INVALID",
            "message": "Invalid visitor pass.",
            "details": {},
        }
    events = scan_app.state.recorded
    assert [(event.action, dict(event.metadata), event.entity_id) for event in events] == [
        ("PASS_SCANNED", {"outcome": "INVALID"}, None)
    ] * 2


def test_well_formed_scan_passes_classification(scan_app: FastAPI) -> None:
    response = TestClient(scan_app).post("/reception/scan", json={"token": f"https://h/pass#{TOKEN}"})
    assert response.status_code == 200
    assert scan_app.state.recorded == []
