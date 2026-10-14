"""Structured logging.

JSON lines on stdout (or a readable text format when LOG_JSON=false). Values under sensitive keys are
redacted wherever they appear in `extra`, and `uvicorn.access` is disabled because our own access log
(see middleware) omits query strings. LOG_LEVEL applies to the application's loggers; uvicorn's and the
`websockets` library's never log below INFO, because their debug output is protocol detail written into
the message text, where nothing is redacted (the WebSocket handshake logs every request header, cookies
included, SEC-45).

Log lines carry text clients choose (the request path, unknown field names), so they are kept inert
and intact:
* JSON escapes only U+0000-U+001F; DEL, the C1 controls (U+0080-U+009F: 8-bit CSI, OSC, NEL, …) and
  the Unicode line and paragraph separators are escaped as well (`\\u009b`). A terminal running
  `tail -f`/`docker logs` cannot be driven by them, and line-oriented tools do not split a record.
* A record is never dropped because the stream cannot encode a character (Windows writes redirected
  stdout as cp1252): such characters are written as backslash escapes instead.
* The DETAIL of a PostgreSQL error (`Key (email)=(…)`, `Failing row contains (…)`) carries row values,
  i.e. personal data; formatted exceptions show "[redacted]" in its place (`hide_parameters` on the
  engine only hides bound parameters, not the server's message).
"""

import json
import logging
import re
import sys
from collections.abc import Iterator, Mapping
from datetime import UTC, datetime
from types import TracebackType
from typing import Any, TextIO

from app.core.config import Settings
from app.core.request_context import current_request_id

REDACTED = "[REDACTED]"
_SENSITIVE_KEY = re.compile(
    r"pass(word|wd)?|token|secret|cookie|authorization|csrf|api[_-]?key|credential", re.IGNORECASE
)
_MAX_DEPTH = 6

# Attributes every LogRecord has; anything else on a record came from `extra=`. uvicorn adds an
# ANSI-coloured duplicate of its message ("color_message") that has no place in structured logs.
_STANDARD_ATTRS = frozenset(vars(logging.makeLogRecord({}))) | {
    "message",
    "asctime",
    "taskName",
    "color_message",
}


# Characters JSON leaves raw that a terminal or a line-oriented tool acts on: DEL, the C1 controls, and
# U+2028/U+2029 (line and paragraph separators). U+0085 (NEL) is a C1 control.
_INERT_ESCAPES = re.compile("[\x7f-\x9f\u2028\u2029]")
# The same for free text outside JSON (text format messages): C0 controls other than tab and newline.
_TEXT_ESCAPES = re.compile("[\x00-\x08\x0b-\x1f\x7f-\x9f\u2028\u2029]")
EXCEPTION_DETAIL_REDACTED = "[redacted]"
_EXC_INFO = tuple[type[BaseException], BaseException, TracebackType | None] | tuple[None, None, None]
# Server and protocol libraries whose DEBUG output carries raw request data in the message text.
PROTOCOL_LOGGERS = ("uvicorn", "uvicorn.error", "websockets")
# uvicorn's advice for an upgrade request when no WebSocket protocol is configured: the server runs with
# `ws="none"` on purpose (`app.serve`), so the advice to install a WebSocket library is wrong here.
_NO_WEBSOCKET_LIBRARY = "No supported WebSocket library detected"


def _escape(match: re.Match[str]) -> str:
    return f"\\u{ord(match.group()):04x}"


def make_inert(text: str, *, keep_line_breaks: bool = True) -> str:
    """`text` with the characters a terminal or log tool would act on written as `\\uXXXX` escapes
    (valid inside a JSON string). Tab and newline stay unless `keep_line_breaks` is false."""
    inert = _TEXT_ESCAPES.sub(_escape, text)
    if keep_line_breaks:
        return inert
    return inert.replace("\t", "\\t").replace("\n", "\\n")


def _json_line(payload: Mapping[str, Any]) -> str:
    return _INERT_ESCAPES.sub(_escape, json.dumps(payload, default=str, ensure_ascii=False))


def _exception_chain(error: BaseException | None) -> Iterator[BaseException]:
    seen: set[int] = set()
    pending = [error]
    while pending:
        current = pending.pop()
        if current is None or id(current) in seen:
            continue
        seen.add(id(current))
        yield current
        pending += [current.__cause__, current.__context__, getattr(current, "orig", None)]


def scrub_database_details(text: str, error: BaseException | None) -> str:
    """`text` (a formatted exception) without the DETAIL of any PostgreSQL error in `error`'s chain:
    for constraint violations it quotes row values (names, e-mail addresses, phone numbers)."""
    for current in _exception_chain(error):
        diag = getattr(current, "diag", None)
        detail = getattr(diag, "message_detail", None)
        if isinstance(detail, str) and detail.strip():
            text = text.replace(detail, EXCEPTION_DETAIL_REDACTED)
    return text


def redact(value: Any, depth: int = 0) -> Any:
    if depth > _MAX_DEPTH:
        return "[TRUNCATED]"
    if isinstance(value, Mapping):
        return {
            str(key): REDACTED if _SENSITIVE_KEY.search(str(key)) else redact(item, depth + 1)
            for key, item in value.items()
        }
    if isinstance(value, list | tuple | set | frozenset):
        return [redact(item, depth + 1) for item in value]
    return value


def _extra_fields(record: logging.LogRecord) -> dict[str, Any]:
    return {key: value for key, value in vars(record).items() if key not in _STANDARD_ATTRS}


class _SafeExceptionFormatter(logging.Formatter):
    def formatException(self, ei: _EXC_INFO) -> str:  # noqa: N802 - logging.Formatter's API
        return scrub_database_details(super().formatException(ei), ei[1])


class JsonFormatter(_SafeExceptionFormatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "ts": datetime.fromtimestamp(record.created, UTC).isoformat().replace("+00:00", "Z"),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        request_id = current_request_id()
        if request_id:
            payload["request_id"] = request_id
        payload.update(redact(_extra_fields(record)))
        if record.exc_info:
            payload["exc_info"] = self.formatException(record.exc_info)
        return _json_line(payload)


class TextFormatter(_SafeExceptionFormatter):
    def format(self, record: logging.LogRecord) -> str:
        timestamp = datetime.fromtimestamp(record.created, UTC).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
        request_id = current_request_id()
        line = f"{timestamp} {record.levelname:<8} {record.name}"
        if request_id:
            line += f" [{request_id}]"
        line += " " + make_inert(record.getMessage(), keep_line_breaks=False)
        extra = redact(_extra_fields(record))
        if extra:
            line += " " + _json_line(extra)
        if record.exc_info:
            line += "\n" + make_inert(self.formatException(record.exc_info))
        return line


class _AppLogHandler(logging.StreamHandler[TextIO]):
    """The handler installed here (reconfiguration replaces only this type). It never drops a record
    because its stream cannot encode a character: those are written as backslash escapes instead."""

    def format(self, record: logging.LogRecord) -> str:
        text = super().format(record)
        encoding = getattr(self.stream, "encoding", None)
        if not isinstance(encoding, str):
            return text
        try:
            text.encode(encoding)
        except UnicodeEncodeError:
            return text.encode(encoding, errors="backslashreplace").decode(encoding)
        except LookupError:
            pass
        return text


class _NoWebSocketAdvice(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        return not str(record.msg).startswith(_NO_WEBSOCKET_LIBRARY)


def configure_logging(settings: Settings) -> None:
    handler = _AppLogHandler(sys.stdout)
    handler.setFormatter(JsonFormatter() if settings.log_json else TextFormatter())
    root = logging.getLogger()
    root.handlers[:] = [h for h in root.handlers if not isinstance(h, _AppLogHandler)] + [handler]
    root.setLevel(settings.log_level)

    protocol_level = max(logging.INFO, logging.getLevelNamesMapping()[settings.log_level])
    for name in PROTOCOL_LOGGERS:
        protocol_logger = logging.getLogger(name)
        protocol_logger.handlers[:] = []
        protocol_logger.propagate = True
        protocol_logger.setLevel(protocol_level)
    uvicorn_error = logging.getLogger("uvicorn.error")
    uvicorn_error.filters[:] = [f for f in uvicorn_error.filters if not isinstance(f, _NoWebSocketAdvice)]
    uvicorn_error.addFilter(_NoWebSocketAdvice())
    access = logging.getLogger("uvicorn.access")
    access.handlers[:] = []
    access.propagate = False
    access.disabled = True
    # SQL statements may carry personal data in parameters; never echo them through logging.
    logging.getLogger("sqlalchemy.engine").setLevel(logging.WARNING)
