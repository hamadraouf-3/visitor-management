"""Request paths as the router sees them, and route templates for audit metadata (contract §3.2-8).

`route_path` is the path every security decision must use. Behind a reverse proxy mounted under a prefix
(`uvicorn --root-path /vms`), ASGI servers put the prefix into both `root_path` and `path`, and Starlette
routes on the path with `root_path` removed. Deciding on the raw `scope["path"]` instead would make the
CSRF/Origin middleware skip requests that the router still dispatches (fail open).

Audit rows name the route template (`/api/v1/users/{user_id}`), never the concrete path: the path is
attacker-controlled and carries IDs and arbitrary input. FastAPI 0.142 keeps router-relative paths on
included routes, so the full template comes from `fastapi.routing.iter_route_contexts`, the public
enumeration of effective routes that OpenAPI generation uses as well.
"""

import re
from functools import lru_cache

from fastapi.routing import APIRoute, iter_route_contexts
from starlette.routing import compile_path
from starlette.types import Scope

UNMATCHED_ROUTE = "unmatched"
# The platform owner's API (B11-6): its own session cookie, CSRF token and audit trail.
PLATFORM_PREFIX = "/api/v1/platform"


# The public identity endpoints (B12-9): no session, no cookie, cacheable responses.
PUBLIC_PREFIX = "/api/v1/public"


def is_public_path(path: str) -> bool:
    """Whether a route path (`route_path`) belongs to the public identity endpoints."""
    return path.startswith(PUBLIC_PREFIX + "/")


def is_platform_path(path: str) -> bool:
    """Whether a route path (`route_path`) belongs to the platform owner's API."""
    return path == PLATFORM_PREFIX or path.startswith(PLATFORM_PREFIX + "/")


def route_path(scope: Scope) -> str:
    """`scope["path"]` without the `root_path` prefix: the path Starlette's router matches.

    Same rules as Starlette's (private) `starlette._utils.get_route_path`, which a unit test compares
    against: the prefix is removed only when it ends at a segment boundary.
    """
    path: str = scope["path"]
    root_path: str = scope.get("root_path", "")
    if not root_path or not path.startswith(root_path):
        return path
    if path == root_path:
        return ""
    if path[len(root_path)] == "/":
        return path[len(root_path) :]
    return path


@lru_cache(maxsize=512)
def _template_regex(template: str) -> re.Pattern[str]:
    regex, _format, _convertors = compile_path(template)
    return regex


def route_template(scope: Scope) -> str:
    """Full template of the API route serving `scope`, or "unmatched".

    After routing, the route FastAPI selected (`scope["route"]`) decides. Before routing (e.g. in the
    CSRF middleware) the path is matched against every API route: a route that allows the method wins,
    otherwise one that only matches the path (a 405 candidate) is reported.
    """
    app = scope.get("app")
    if app is None:
        return UNMATCHED_ROUTE
    routed = scope.get("route")
    path = route_path(scope)
    method: str = scope["method"]
    path_only: str | None = None
    for context in iter_route_contexts(app.router.routes):
        route = context.original_route
        template = context.path
        if not isinstance(route, APIRoute) or not template:
            continue
        if routed is not None and route is not routed:
            continue  # after routing only the selected route can answer (cheaper than its pattern)
        if _template_regex(template).match(path) is None:
            continue
        if routed is not None:
            return template
        if route.methods and method in route.methods:
            return template
        if path_only is None:
            path_only = template
    return path_only or UNMATCHED_ROUTE
