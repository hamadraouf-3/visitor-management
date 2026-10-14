"""`route_path` must strip `root_path` exactly as Starlette's router does (security decisions use it)."""

import pytest
from starlette._utils import get_route_path  # private: compared against on purpose, to catch drift

from app.core.routing import route_path

CASES = [
    ("/api/v1/users", ""),
    ("/api/v1/users", "/vms"),
    ("/vms/api/v1/users", "/vms"),
    ("/vms", "/vms"),
    ("/vmsx/api/v1/users", "/vms"),  # not a segment boundary: unchanged
    ("/vms/", "/vms"),
    ("/a/b/api/v1/x", "/a/b"),
    ("/api/v1/users", "/api"),
]


@pytest.mark.parametrize(("path", "root_path"), CASES)
def test_route_path_agrees_with_starlette(path: str, root_path: str) -> None:
    scope = {"type": "http", "path": path, "root_path": root_path}
    assert route_path(scope) == get_route_path(scope)


def test_route_path_examples() -> None:
    assert route_path({"path": "/vms/api/v1/departments", "root_path": "/vms"}) == "/api/v1/departments"
    assert route_path({"path": "/api/v1/departments"}) == "/api/v1/departments"
