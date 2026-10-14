import json
import logging

from app.core.logging import REDACTED, JsonFormatter, TextFormatter, configure_logging, redact
from app.core.request_context import reset_request_id, set_request_id


def _record(message: str = "hello", **extra) -> logging.LogRecord:
    record = logging.makeLogRecord({"name": "app.test", "levelname": "INFO", "msg": message})
    for key, value in extra.items():
        setattr(record, key, value)
    return record


def test_redacts_sensitive_keys_recursively() -> None:
    data = {
        "password": "p",
        "new_password": "p",
        "Authorization": "Bearer x",
        "cookie": "a=b",
        "headers": {"X-CSRF-Token": "t", "user-agent": "ua"},
        "items": [{"reset_token": "r"}, {"name": "ok"}],
        "api_key": "k",
        "count": 3,
    }
    clean = redact(data)
    assert clean["password"] == clean["new_password"] == REDACTED
    assert clean["Authorization"] == clean["cookie"] == clean["api_key"] == REDACTED
    assert clean["headers"] == {"X-CSRF-Token": REDACTED, "user-agent": "ua"}
    assert clean["items"] == [{"reset_token": REDACTED}, {"name": "ok"}]
    assert clean["count"] == 3


def test_json_formatter_includes_request_id_and_redacted_extras() -> None:
    token = set_request_id("req-12345678")
    try:
        line = JsonFormatter().format(_record(session_token="secret-value", path="/api/v1/x", status=200))
    finally:
        reset_request_id(token)
    payload = json.loads(line)
    assert payload["message"] == "hello"
    assert payload["request_id"] == "req-12345678"
    assert payload["session_token"] == REDACTED
    assert payload["path"] == "/api/v1/x" and payload["status"] == 200
    assert payload["ts"].endswith("Z")
    assert "secret-value" not in line


def test_text_formatter_redacts_too() -> None:
    line = TextFormatter().format(_record(password="hunter2"))
    assert "hunter2" not in line and REDACTED in line


def test_configure_logging_disables_uvicorn_access() -> None:
    from app.core.config import Settings

    configure_logging(
        Settings(_env_file=None, app_env="development", database_url="postgresql://u:p@h/d", log_level="INFO")
    )
    access = logging.getLogger("uvicorn.access")
    assert access.disabled is True and access.propagate is False
    configure_logging(
        Settings(_env_file=None, app_env="development", database_url="postgresql://u:p@h/d", log_level="INFO")
    )
    ours = [h for h in logging.getLogger().handlers if type(h).__name__ == "_AppLogHandler"]
    assert len(ours) == 1  # reconfiguration replaces, never duplicates


# ---- inert, complete log lines (SEC-11) -----------------------------------------------------------

# Characters a terminal or a line-oriented tool acts on that JSON leaves raw: 8-bit CSI, OSC, DCS, ST,
# NEL, DEL and the Unicode line and paragraph separators.
_HOSTILE = "/api/v1/x" + "".join(chr(c) for c in (0x9B, 0x9D, 0x90, 0x9C, 0x85, 0x7F, 0x2028, 0x2029)) + "2J"


def _raw_controls(text: str) -> list[str]:
    return [ch for ch in text if 0x7F <= ord(ch) <= 0x9F or ord(ch) in (0x2028, 0x2029)]


def test_json_lines_escape_c1_controls_and_line_separators() -> None:
    line = JsonFormatter().format(_record(_HOSTILE, path=_HOSTILE, loc=[_HOSTILE]))
    assert _raw_controls(line) == []
    assert "\n" not in line
    payload = json.loads(line)
    assert payload["path"] == _HOSTILE and payload["message"] == _HOSTILE  # escaped, not lost
    assert payload["loc"] == [_HOSTILE]


def test_text_lines_escape_controls_in_messages_and_extras() -> None:
    line = TextFormatter().format(_record(_HOSTILE + "\nforged line\x1b[31m", path=_HOSTILE))
    assert _raw_controls(line) == []
    assert "\n" not in line and "\x1b" not in line


def test_a_record_the_stream_cannot_encode_is_written_escaped_not_dropped() -> None:
    import io

    from app.core.logging import _AppLogHandler

    buffer = io.BytesIO()
    stream = io.TextIOWrapper(buffer, encoding="cp1252")  # Windows: redirected stdout
    handler = _AppLogHandler(stream)
    handler.setFormatter(JsonFormatter())
    handler.emit(_record("arrived", path="/api/v1/visitors/الاسم"))
    stream.flush()
    written = buffer.getvalue().decode("cp1252")
    assert '"message": "arrived"' in written
    assert r"\u0627" in written  # the Arabic path survives as escapes
