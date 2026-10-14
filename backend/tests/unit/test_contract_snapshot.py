"""The committed API contract snapshot must match the backend schemas (contract §3.2-9).

`frontend/src/types/api.contract.test.ts` checks `api.ts` against the snapshot, so a stale snapshot would
let the TypeScript mirror drift from the Pydantic models without any test noticing.
"""

import json

import pytest

from app import contract

STALE_MESSAGE = (
    "frontend/src/types/backend-contract.json is stale: run `npm run contract:snapshot` in frontend/ "
    "(or `python -m app.contract --out ../frontend/src/types/backend-contract.json` in backend/), "
    "then update frontend/src/types/api.ts until its contract test passes."
)


def test_committed_snapshot_matches_the_backend_schemas() -> None:
    if not contract.SNAPSHOT_PATH.is_file():
        pytest.fail(f"{contract.SNAPSHOT_PATH} is missing. {STALE_MESSAGE}")
    committed = json.loads(contract.SNAPSHOT_PATH.read_text(encoding="utf-8"))
    current = json.loads(contract.render())
    # Compared as data: the file's line endings follow the checkout (core.autocrlf), not the generator.
    assert committed == current, STALE_MESSAGE


def test_snapshot_publishes_queries_and_envelopes() -> None:
    snapshot = contract.build()
    assert {
        "PageParams",
        "UserListParams",
        "VisitListParams",
        "VisitorSearchParams",
        "AuditLogListParams",
        "ReportSummaryParams",
    } <= set(snapshot["queries"])
    assert {
        "ApiErrorEnvelope",
        "VisitPage",
        "UserPage",
        "VisitorSearchPage",
        "AuditLogPage",
        "PlatformCompanyPage",  # Phase 11
        "PlatformAuditLogPage",
    } == set(snapshot["envelopes"])
    # Query models reject unknown parameters, like request bodies reject unknown fields.
    definitions = snapshot["$defs"]
    for name, schema in snapshot["queries"].items():
        resolved = definitions[schema["$ref"].removeprefix("#/$defs/")]
        assert resolved["additionalProperties"] is False, name


def test_contract_names_must_be_unique_per_mode(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setitem(contract.QUERIES, "LoginRequest", contract.QUERIES["PageParams"])
    with pytest.raises(ValueError, match="LoginRequest"):
        contract.build()


def test_snapshot_lists_every_error_code() -> None:
    codes = contract.build()["error_codes"]
    assert codes == sorted(set(codes))
    assert {"VALIDATION_ERROR", "PASS_INVALID", "METHOD_NOT_ALLOWED", "BAD_REQUEST"} <= set(codes)


def test_snapshot_lists_every_field_error_code_with_its_parameters() -> None:
    """B10-18: the vocabulary of `details.field_codes`, for checking the frontend's catalog against it."""
    vocabulary = contract.build()["field_error_codes"]
    assert list(vocabulary) == sorted(vocabulary)
    assert vocabulary["required"] == [] and vocabulary["too_long"] == ["max"]
    assert vocabulary["invalid_choice"] == ["choices"]
    assert vocabulary["date_out_of_range"] == ["max", "min"]
    assert vocabulary["too_many_reinvitations"] == ["count", "limit"]


def test_cli_writes_the_rendered_snapshot(tmp_path, capsys) -> None:
    target = tmp_path / "snapshot.json"
    contract.main(["--out", str(target)])
    assert json.loads(target.read_text(encoding="utf-8")) == json.loads(contract.render())
    assert "Wrote" in capsys.readouterr().out
