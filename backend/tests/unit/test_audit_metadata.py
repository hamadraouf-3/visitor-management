import uuid
from enum import StrEnum

import pytest

from app.services.audit import sanitize_metadata


class Kind(StrEnum):
    A = "A"


def test_allows_ids_enums_counts_and_field_names() -> None:
    value = uuid.uuid4()
    clean = sanitize_metadata(
        {
            "entity": value,
            "kind": Kind.A,
            "count": 3,
            "ratio": 0.5,
            "flag": True,
            "nothing": None,
            "changed_fields": ["full_name", "phone"],
            "roles": {"EMPLOYEE", "MANAGEMENT"},
            "route": "/api/v1/users/{user_id}",
            "policy": "login_failures_ip_email",
        }
    )
    assert clean == {
        "entity": str(value),
        "kind": "A",
        "count": 3,
        "ratio": 0.5,
        "flag": True,
        "nothing": None,
        "changed_fields": ["full_name", "phone"],
        "roles": ["EMPLOYEE", "MANAGEMENT"],
        "route": "/api/v1/users/{user_id}",
        "policy": "login_failures_ip_email",
    }


@pytest.mark.parametrize(
    "metadata",
    [
        {"note": "x" * 101},
        {"email": "person@example.com"},
        {"name": "Jane Doe"},
        {"phone": "+962 79 123 4567"},
        {"phone": "+962791234567"},
        {"note": ""},
        {"note": "line\nbreak"},
        {"names": ["ok", "Jane Doe"]},
        {"nested": {"email": "person@example.com"}},
        {"blob": b"bytes"},
        {"": 1},
        {"k" * 65: 1},
        {"many": list(range(51))},
    ],
)
def test_rejects_free_text_and_structures(metadata: dict) -> None:
    with pytest.raises(ValueError, match="audit metadata"):
        sanitize_metadata(metadata)
