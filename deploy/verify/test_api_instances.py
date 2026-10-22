"""Tests of the API layout (docs/decisions/phase-9-deploy.md D9-34, D9-35; deploy/README.md §4).

    python3 -m unittest discover -s deploy/verify -p "test_*.py" -v

Each API process runs one worker, because its rate limiter lives in its memory. nginx therefore shares
the API requests out by method and raw path (D9-36): GET requests for the reception lists go to
`backend-reception` (two replicas, the least busy one per request), the reports, audit, admin dashboard
and visit history reads go to `backend-reports`, and everything else (every sign-in and every write)
stays on `backend`, which runs exactly one process. These tests keep the parts that must agree in
step: the routing map, the upstreams and the startup check of the nginx template, the image defaults,
the backend's routes, the backend test of the routed reads and the compose services and their
settings.

The map matches the path exactly as the client sent it, the path nginx forwards and the API dispatches
on (D9-36), so a read process runs only the routes listed here.

Phase 12 (docs/decisions/phase-12-backend.md): a company's identity. Its routes (the platform owner's
brand and e-mail-text endpoints, the public identity endpoints) all stay on the main instance, and one of
them, the upload of a brand image, is the one request whose body may exceed 64 KiB: nginx gives exactly
that path its own limit, equal to the API's. It is also the one request that is counted while it is in
progress (a few at a time on the site, fewer from one address), and a place is taken before anyone is
asked who they are. So nothing may keep a place without being signed in (B12-18): the body is passed
on while it arrives, the API answers a stranger without reading it, the connection is closed with that
answer, and only a PUT is counted.

The nginx and backend checks need only the standard library. The compose checks need PyYAML (a backend
dependency: run them with the backend's environment, as CI does); without it they are skipped.
"""

from __future__ import annotations

import ast
import re
import unittest
from pathlib import Path

try:
    import yaml
except ImportError:  # pragma: no cover - the standard-library-only run
    yaml = None

ROOT = Path(__file__).resolve().parents[2]
NGINX = ROOT / "deploy" / "nginx"
TEMPLATE = NGINX / "templates" / "vms.conf.template"
MAIN_CONF = NGINX / "nginx.conf"
API_PROXY = NGINX / "snippets" / "api-proxy.conf"
CHECK_SCRIPT = NGINX / "docker-entrypoint.d" / "25-vms-check-config.sh"
FRONTEND_DOCKERFILE = ROOT / "frontend" / "Dockerfile"
COMPOSE = ROOT / "docker-compose.yml"
BACKEND_ENV = ROOT / "deploy" / "env" / "backend.env.example"
ROUTES = ROOT / "backend" / "app" / "api" / "routes"
# Where the API keeps the size a brand image may have (`BRAND_ASSET_MAX_BYTES`).
BRAND_MODEL = ROOT / "backend" / "app" / "models" / "brand.py"
# The backend test that each routed read consults only the per-user API budget (`ROUTED_READS`).
ROUTED_READS_TEST = ROOT / "backend" / "tests" / "integration" / "test_routed_reads.py"
API_PREFIX = "/api/v1"

MAIN, RECEPTION, REPORTS = "vms_api", "vms_api_reception", "vms_api_reports"
# The whole routing table. A change here is a change of who counts which budget: update
# deploy/README.md §4 and D9-34 with it. A routed endpoint must consult no rate-limit budget but the
# per-user API budget, which each process counts for the requests it receives; any other budget must be
# counted on the main instance only. backend/tests/integration/test_routed_reads.py checks that for
# every role and answer, and its `ROUTED_READS` must list exactly these requests (tested below).
EXPECTED_ROUTES = {
    "GET /api/v1/reception/today": RECEPTION,
    "GET /api/v1/reception/inside": RECEPTION,
    "GET /api/v1/reports/summary": REPORTS,
    "GET /api/v1/audit-logs": REPORTS,
    "GET /api/v1/dashboard/admin": REPORTS,
    "GET /api/v1/visits": REPORTS,
}
# Phase 11: the platform owner's API and a company's e-mail texts. Not routed: every request of theirs
# goes to the main instance (the map's default), which counts their budgets (B11-6, B11-29).
# Phase 12: a company's identity, set by the platform owner (brand changes have an hourly budget per
# platform account, B12-7), and the public identity endpoints, whose budgets per client address and per
# IPv6 /48 bound probing for companies (B12-9). Those budgets live in the main process's memory: a
# read process would count them a second time, so none of these requests is routed away either.
# Phase 15: the Visitor Journey's tracking endpoints. The provider's ingestion counts a budget per key and
# one per client address for wrong keys (B15-17), in the main process's memory, so none is routed away.
MAIN_ONLY_PREFIXES = (
    f"{API_PREFIX}/platform/",
    f"{API_PREFIX}/email-templates",
    f"{API_PREFIX}/public/",
    f"{API_PREFIX}/tracking/",
)
MAIN_ONLY_ROUTES = frozenset(
    {
        "POST /api/v1/platform/auth/login",
        "POST /api/v1/platform/auth/logout",
        "GET /api/v1/platform/auth/me",
        "PATCH /api/v1/platform/auth/preferences",
        "POST /api/v1/platform/auth/change-password",
        "GET /api/v1/platform/companies",
        "POST /api/v1/platform/companies",
        "GET /api/v1/platform/companies/{company_id}",
        "PATCH /api/v1/platform/companies/{company_id}",
        "POST /api/v1/platform/companies/{company_id}/deactivate",
        "POST /api/v1/platform/companies/{company_id}/reactivate",
        "PATCH /api/v1/platform/companies/{company_id}/tracking",  # Phase 15 (B15-2)
        "GET /api/v1/platform/companies/{company_id}/admins",
        "POST /api/v1/platform/companies/{company_id}/admins",
        "POST /api/v1/platform/companies/{company_id}/admins/{user_id}/password-reset",
        "GET /api/v1/platform/audit-logs",
        "GET /api/v1/platform/companies/{company_id}/brand",
        "PATCH /api/v1/platform/companies/{company_id}/brand",
        "PUT /api/v1/platform/companies/{company_id}/brand/assets/{kind}",
        "DELETE /api/v1/platform/companies/{company_id}/brand/assets/{kind}",
        "POST /api/v1/platform/brand/palette",
        "GET /api/v1/platform/companies/{company_id}/email-templates",
        "GET /api/v1/platform/companies/{company_id}/email-templates/{kind}",
        "PATCH /api/v1/platform/companies/{company_id}/email-templates/{kind}",
        "POST /api/v1/platform/companies/{company_id}/email-templates/{kind}/reset",
        "POST /api/v1/platform/companies/{company_id}/email-templates/{kind}/preview",
        "GET /api/v1/platform/companies/{company_id}/email-templates/{kind}/preview",
        "POST /api/v1/platform/companies/{company_id}/email-templates/{kind}/test",
        "GET /api/v1/public/companies/{slug}/brand",
        "GET /api/v1/public/companies/{slug}/brand/{kind}.png",
        "GET /api/v1/public/companies/{slug}/manifest.webmanifest",
        "GET /api/v1/email-templates",
        "GET /api/v1/email-templates/{kind}",
        "PATCH /api/v1/email-templates/{kind}",
        "POST /api/v1/email-templates/{kind}/reset",
        "POST /api/v1/email-templates/{kind}/preview",
        "GET /api/v1/email-templates/{kind}/preview",
        "POST /api/v1/email-templates/{kind}/test",
        # Phase 15: the Visitor Journey's tracking endpoints.
        "GET /api/v1/tracking/status",
        "GET /api/v1/tracking/settings",
        "PATCH /api/v1/tracking/settings",
        "GET /api/v1/tracking/keys",
        "POST /api/v1/tracking/keys",
        "DELETE /api/v1/tracking/keys/{key_id}",
        "GET /api/v1/tracking/cameras",
        "POST /api/v1/tracking/cameras",
        "PATCH /api/v1/tracking/cameras/{camera_id}",
        "POST /api/v1/tracking/events",
        # Phase 16: the area alerts (docs/decisions/phase-16-backend.md, B16-9).
        "GET /api/v1/tracking/alerts",
        "GET /api/v1/tracking/alerts/summary",
        "POST /api/v1/tracking/alerts/{alert_id}/acknowledge",
        "POST /api/v1/tracking/alerts/{alert_id}/resolve",
    }
)
# The one request whose body may exceed MAX_REQUEST_BODY_BYTES (B12-6): the upload of a company's brand
# image. nginx gives the location of exactly this route's paths the API's own limit for it.
BRAND_UPLOAD = "PUT /api/v1/platform/companies/{company_id}/brand/assets/{kind}"
# The API's other PUT routes: a small JSON body under the default limit, outside the upload's location
# (whose paths no other route matches: `test_no_other_route_of_the_api_gets_the_larger_limit`), so no
# upload place is ever counted for them. Phase 16: a visit's allowed areas (B16-2).
OTHER_PUTS = ("PUT /api/v1/visits/{visit_id}/access-areas",)
# Uploads in progress at a time: on the whole site, and from one client address (B12-18). The platform
# owner's page uploads one image at a time; several operators may share an address. No single address
# may have more than half the site's places.
MAX_UPLOADS_IN_PROGRESS = 8
MAX_UPLOADS_PER_ADDRESS = 4
# Where the API bounds the time an upload's body may take to arrive (`PNG_UPLOAD_SECONDS`): with the body
# passed on while it arrives, nginx bounds only the pause between two reads.
API_DEPENDENCIES = ROOT / "backend" / "app" / "api" / "deps.py"
# upstream group -> (template variable, image default = compose service:port)
UPSTREAMS = {
    MAIN: ("VMS_API_UPSTREAM", "backend:8000"),
    RECEPTION: ("VMS_API_RECEPTION_UPSTREAM", "backend-reception:8000"),
    REPORTS: ("VMS_API_REPORTS_UPSTREAM", "backend-reports:8000"),
}
ARGON2_MIB = 64  # memory of one Argon2id hash (backend app/security/passwords.py)
# Room for the application itself: about twice the 110-120 MB working set measured under stress B.
APPLICATION_MIB = 256
# The rate limiter's capped buckets at their caps (docs/security.md §9.1: about 200 MB with both full).
# They are keyed by anonymous input (client addresses, typed e-mail addresses), so only the instance that
# receives the sign-ins and password recovery, the main one, can fill them.
LIMITER_CAPS_MIB = 200
# Graceful shutdown (app.serve GRACEFUL_SHUTDOWN_SECONDS) plus the lifespan-shutdown margin of D9-32.
MIN_STOP_GRACE_SECONDS = 20 + 20
# Processes behind the reception-list upstream (D9-35). Stress B (6 polls a second, the desk reloading the
# list after every check-in): one process missed the 300 ms reception budget in most of the re-audit's
# runs, because one interpreter builds one list at a time (about 40 ms each) and the polls arrive in
# bursts; two held it in every run.
MIN_LIST_REPLICAS = 2
# The compose `environment` keys a read service may set to a value of its own (security review condition
# 4, docs/security-audit.md §6, R-1 closure note; D9-37): its Argon2 slots and its database pool, sized for
# its smaller limits. Every other setting comes from the shared env file, so the four processes agree on
# sessions, cookies, trusted proxies, origins and rate limits; otherwise they would disagree on the idle
# timeout, the cookie, the client address or a budget. RATE_LIMIT_API_PER_MINUTE belongs here only once
# compose sets lower read budgets (D9-36).
READ_SERVICE_OVERRIDES = frozenset({"PASSWORD_HASH_CONCURRENCY", "DB_POOL_SIZE"})
# Upstream groups whose name may resolve to several servers (one per replica), with their balancing
# method: only read pools. The main instance counts every budget but the per-user API budget; a second
# process of it would double them all.
BALANCED = {RECEPTION: "least_conn"}
BALANCING = r"\b(least_conn|least_time|random|hash|ip_hash)\b[^;]*;"
# A routed path as the API's router matches it: lowercase segments of letters, digits and hyphens. No
# "%" (the API percent-decodes the path, so the bytes nginx matched are the path it dispatches), no "."
# segment, no empty segment and no trailing slash (the API resolves neither, and has no such routes).
CANONICAL_PATH = re.compile(rf"{re.escape(API_PREFIX)}(/[a-z0-9]+(-[a-z0-9]+)*)+")


def strip_comments(text: str) -> str:
    return "\n".join(line.split("#", 1)[0] for line in text.splitlines())


def routing_map(template: str) -> tuple[str, dict[str, str]]:
    """(default, {"METHOD /path": upstream}) of the `$vms_api_pool` map."""
    match = re.search(
        r'^map\s+"\$request_method \$vms_request_path"\s+\$vms_api_pool\s*\{(.*?)^\}', template, re.M | re.S
    )
    if not match:
        raise AssertionError('no `map "$request_method $vms_request_path" $vms_api_pool` block')
    default, entries = None, {}
    for line in strip_comments(match.group(1)).splitlines():
        line = line.strip()
        if not line:
            continue
        entry = re.fullmatch(r'(default|"[^"]+")\s+(\S+);', line)
        if not entry:
            raise AssertionError(f"unexpected line in the routing map: {line!r}")
        key, value = entry.groups()
        if key == "default":
            default = value
        else:
            key = key.strip('"')
            if key in entries:
                raise AssertionError(f"duplicate key {key!r}")
            entries[key] = value
    if default is None:
        raise AssertionError("the routing map has no default")
    return default, entries


def map_entries(conf: str, source: str, variable: str) -> list[str]:
    """The entry lines of `map <source> <variable> { ... }`, comments and blank lines left out."""
    pattern = rf"\bmap\s+{re.escape(source)}\s+{re.escape(variable)}\s*\{{(.*?)\}}"
    match = re.search(pattern, strip_comments(conf), re.S)
    if not match:
        raise AssertionError(f"no `map {source} {variable}` block")
    return [" ".join(line.split()) for line in match.group(1).splitlines() if line.strip()]


def block_end(text: str, start: int) -> int:
    """The index of the `}` that closes the block whose `{` is at `start`."""
    depth = 0
    for index in range(start, len(text)):
        if text[index] == "{":
            depth += 1
        elif text[index] == "}":
            depth -= 1
            if depth == 0:
                return index
    raise AssertionError("unbalanced braces")


def directives(body: str) -> list[str]:
    """The directives of a block's body, one string each, in order."""
    return [" ".join(directive.split()) for directive in body.split(";") if directive.strip()]


def api_locations(template: str) -> dict[str, tuple[list[str], dict[str, list[str]]]]:
    """The locations of the API in the application's server: for `^~ /api/` and `= /api`, the directives
    of the location itself and those of each location nested in it, by its matcher."""
    text = strip_comments(template)
    found: dict[str, tuple[list[str], dict[str, list[str]]]] = {}
    for match in re.finditer(r"location\s+(\^~\s+/api/|=\s+/api)\s*\{", text):
        end = block_end(text, match.end() - 1)
        body = text[match.end() : end]
        nested: dict[str, list[str]] = {}
        own = ""
        position = 0
        for inner in re.finditer(r"location\s+([^{]+?)\s*\{", body):
            if inner.start() < position:
                raise AssertionError("a location nested twice")
            inner_end = block_end(body, inner.end() - 1)
            own += body[position : inner.start()]
            nested[" ".join(inner.group(1).split())] = directives(body[inner.end() : inner_end])
            position = inner_end + 1
        own += body[position:]
        found[" ".join(match.group(1).split())] = (directives(own), nested)
    return found


def size_in_bytes(value: str) -> int:
    """An nginx size (64k, 1m, 512)."""
    number = re.fullmatch(r"(\d+)([km]?)", value)
    if not number:
        raise AssertionError(f"unexpected nginx size {value!r}")
    return int(number[1]) * {"": 1, "k": 1024, "m": 1024 * 1024}[number[2]]


def setting(directives_: list[str], name: str) -> str:
    """The one value of directive `name` among `directives_`."""
    values = [directive.split(" ", 1)[1] for directive in directives_ if directive.split(" ", 1)[0] == name]
    if len(values) != 1:
        raise AssertionError(f"{name}: expected exactly one, found {values}")
    return values[0]


def upstream_blocks(template: str) -> dict[str, str]:
    pattern = re.compile(r"^upstream\s+(\S+)\s*\{(.*?)^\}", re.M | re.S)
    return dict(pattern.findall(strip_comments(template)))


def route_pattern(template: str) -> re.Pattern[str]:
    """What the API's router matches for a route template: Starlette's `{name}` is one non-empty segment,
    `{name:path}` anything."""
    regex, position = "", 0
    for parameter in re.finditer(r"\{[^}:]+(:[a-z]+)?\}", template):
        regex += re.escape(template[position : parameter.start()])
        regex += ".*" if parameter.group(1) == ":path" else "[^/]+"
        position = parameter.end()
    return re.compile(regex + re.escape(template[position:]), re.IGNORECASE)


def routed_reads_of_the_backend_test() -> set[str]:
    """The keys of `ROUTED_READS` in the backend test of the routed reads."""
    tree = ast.parse(ROUTED_READS_TEST.read_text(encoding="utf-8"))
    for node in tree.body:
        if isinstance(node, ast.AnnAssign | ast.Assign):
            targets = [node.target] if isinstance(node, ast.AnnAssign) else node.targets
            if any(isinstance(target, ast.Name) and target.id == "ROUTED_READS" for target in targets):
                if not isinstance(node.value, ast.Dict):
                    raise AssertionError("ROUTED_READS is not a dict literal")
                return {ast.literal_eval(key) for key in node.value.keys if key is not None}
    raise AssertionError(f"no ROUTED_READS in {ROUTED_READS_TEST}")


def backend_routes() -> set[str]:
    """Every "METHOD /api/v1/path" the API declares (FastAPI decorators in app/api/routes)."""
    routes = set()
    for module in sorted(ROUTES.glob("*.py")):
        source = module.read_text(encoding="utf-8")
        prefix = re.search(r'router = APIRouter\((?:[^)]*?prefix="([^"]*)")?', source)
        if prefix is None:
            continue
        for method, path in re.findall(r'@router\.(get|post|put|patch|delete)\(\s*"([^"]*)"', source):
            routes.add(f"{method.upper()} {API_PREFIX}{prefix.group(1) or ''}{path}")
    return routes


def image_env_defaults() -> dict[str, str]:
    source = FRONTEND_DOCKERFILE.read_text(encoding="utf-8")
    runtime = source[source.index("AS runtime") :]
    env = re.search(r"^ENV\s+((?:.*\\\n)*.*)$", runtime, re.M)
    if not env:
        raise AssertionError("no ENV instruction in the runtime stage of frontend/Dockerfile")
    return dict(re.findall(r'([A-Z_]+)=("[^"]*"|\S+)', env.group(1).replace("\\\n", " ")))


class RoutingMapTests(unittest.TestCase):
    def setUp(self) -> None:
        self.template = TEMPLATE.read_text(encoding="utf-8")
        self.default, self.routes = routing_map(self.template)

    def test_the_routing_table_is_exactly_the_documented_one(self) -> None:
        self.assertEqual(self.default, MAIN)
        self.assertEqual(self.routes, EXPECTED_ROUTES)

    def test_no_write_and_no_sign_in_leaves_the_main_instance(self) -> None:
        # Only GET requests are routed away. Every budget besides the per-user API budget (sign-in
        # failures and lockouts, password recovery, e-mail, scans, attendance) is counted by the
        # requests that stay on the main instance.
        for key in self.routes:
            method, path = key.split(" ", 1)
            self.assertEqual(method, "GET", key)
            self.assertFalse(path.startswith(f"{API_PREFIX}/auth/"), key)

    def test_every_routed_request_is_a_get_route_of_the_api(self) -> None:
        # A renamed or removed route would otherwise silently fall back to the main instance.
        declared = backend_routes()
        self.assertIn("POST /api/v1/auth/login", declared)  # the parser sees the routes at all
        for key in self.routes:
            self.assertIn(key, declared)

    def test_the_platform_and_e_mail_text_routes_stay_on_the_main_instance(self) -> None:
        # Phase 11 (docs/decisions/phase-11-backend.md): the platform owner's API and a company's e-mail
        # texts sign in, write, send test e-mails and count their budgets (platform sign-in failures and
        # lockouts, test e-mails per administrator), so every one of their requests, the reads included,
        # stays on the main instance: none is in the map, and the map's default is the main instance.
        declared = backend_routes()
        self.assertEqual(self.default, MAIN)
        for key in MAIN_ONLY_ROUTES:
            with self.subTest(route=key):
                self.assertIn(key, declared)  # a renamed route must be renamed here too
                self.assertNotIn(key, self.routes)
        for prefix in MAIN_ONLY_PREFIXES:
            self.assertEqual([key for key in self.routes if key.split(" ", 1)[1].startswith(prefix)], [])
            # Every declared route under the prefix is listed above, so a new one is a deliberate choice.
            self.assertEqual(
                {route for route in declared if route.split(" ", 1)[1].startswith(prefix)},
                {route for route in MAIN_ONLY_ROUTES if route.split(" ", 1)[1].startswith(prefix)},
            )

    def test_no_platform_or_e_mail_text_route_matches_a_routed_path(self) -> None:
        # Their templates have path parameters ({company_id}, {kind}): none may match a routed read in any
        # letter case, or a read process would run it.
        for route in MAIN_ONLY_ROUTES:
            template = route.split(" ", 1)[1]
            for key in self.routes:
                self.assertIsNone(route_pattern(template).fullmatch(key.split(" ", 1)[1]), f"{route} ~ {key}")

    def test_the_map_matches_the_path_the_api_receives(self) -> None:
        # nginx forwards the request URI as the client sent it (proxy_pass without a URI part, and no
        # rewrite in the API locations), and the API dispatches on that path. The map must decide on the
        # same bytes: on the normalised $uri, `GET /api/v1/visitors/../visits` matched "GET
        # /api/v1/visits" and ran /visitors/{visitor_id}/visits on the reports instance (D9-36).
        self.assertEqual(
            map_entries(MAIN_CONF.read_text(encoding="utf-8"), "$request_uri", "$vms_request_path"),
            ['"~^(?<path>[^?]*)" $path;', 'default "";'],
        )
        # The API locations proxy, bound the body and read it before the API sees the request, and do
        # nothing else: no rewrite, no second way to an instance. (The nested location is the brand
        # image upload, `BrandUploadTests`: the one body that is passed on while it arrives.)
        locations = api_locations(self.template)
        self.assertEqual(set(locations), {"^~ /api/", "= /api"})
        proxy = [
            "include /etc/nginx/snippets/api-proxy.conf",
            "client_max_body_size 64k",
            "proxy_request_buffering on",
        ]
        for matcher, (own, nested) in locations.items():
            self.assertEqual(own, proxy, matcher)
            for inner, inner_directives in nested.items():
                self.assertEqual(inner_directives[0], proxy[0], inner)
                self.assertFalse([d for d in inner_directives if d.startswith("rewrite")], inner)
                self.assertEqual(
                    [d for d in inner_directives if d.startswith("proxy_")],
                    ["proxy_request_buffering off"],
                    inner,
                )
        self.assertEqual(locations["= /api"][1], {})
        self.assertNotRegex(strip_comments(API_PROXY.read_text(encoding="utf-8")), r"\brewrite\b")
        self.assertNotRegex(strip_comments(self.template), r"\brewrite\b(?!\s+\^\s+/index\.html\s+last;)")

    def test_every_routed_path_is_spelled_as_the_api_routes_it(self) -> None:
        # The API percent-decodes the path and resolves nothing else. A key without "%", "." segments,
        # empty segments or a trailing slash is therefore the very path the API dispatches; any other
        # spelling of it misses the map and goes to the main instance.
        for key in self.routes:
            self.assertIsNotNone(CANONICAL_PATH.fullmatch(key.split(" ", 1)[1]), key)

    def test_no_other_route_matches_a_routed_path_in_any_letter_case(self) -> None:
        # nginx compares map strings without regard to case, so `GET /api/v1/Reception/today` reaches a
        # list replica. The API's routes are case-sensitive: there it must match no route at all (404
        # before authentication), which holds while no other route matches the path in any letter case.
        declared = backend_routes()
        for key in self.routes:
            path = key.split(" ", 1)[1]
            for route in sorted(declared):
                template = route.split(" ", 1)[1]
                if template != path:
                    self.assertIsNone(route_pattern(template).fullmatch(path), f"{route} matches {key}")

    def test_the_backend_suite_checks_the_budget_of_every_routed_read(self) -> None:
        # The map decides what a read process runs; the backend test checks that each routed read
        # consults only the per-user API budget. A request added to one list must be added to the other.
        self.assertEqual(routed_reads_of_the_backend_test(), set(self.routes))

    def test_every_upstream_group_is_defined_and_re_resolved(self) -> None:
        blocks = upstream_blocks(self.template)
        self.assertEqual(set(blocks), set(UPSTREAMS))
        self.assertEqual({self.default, *self.routes.values()}, set(UPSTREAMS))
        for name, (variable, _default) in UPSTREAMS.items():
            body = blocks[name]
            self.assertRegex(body, rf"\bzone\s+{name}\s+\d+k;", name)
            # One server line per group: `resolve` (in a zone) makes every address of the name a server,
            # one per replica, and follows the replicas while nginx runs.
            self.assertEqual(re.findall(r"\bserver\s+([^;]+);", body), [f"${{{variable}}} resolve"], name)
            self.assertRegex(body, r"\bkeepalive\s+\d+;", name)
            # Below uvicorn's 5 s keep-alive: nginx never reuses a connection the API just closed.
            timeout = re.search(r"\bkeepalive_timeout\s+(\d+)s;", body)
            self.assertIsNotNone(timeout, name)
            self.assertLess(int(timeout.group(1)), 5, name)

    def test_the_list_replicas_share_the_requests_by_load(self) -> None:
        # The polls and the desk's reload arrive in bursts, and one list costs about 40 ms of one
        # interpreter: each request goes to the replica with the fewest requests in progress.
        for name, body in upstream_blocks(self.template).items():
            found = re.findall(BALANCING, body)
            self.assertEqual(found, [BALANCED[name]] if name in BALANCED else [], name)
            if found:
                # The order nginx's documentation of `keepalive` requires. nginx 1.30.5 also handled the
                # reverse order in a check (D9-35), and `nginx -t` accepts it: only this test holds it.
                method = re.search(BALANCING, body)
                keepalive = re.search(r"\bkeepalive\s+\d+;", body)
                self.assertLess(method.start(), keepalive.start(), f"{name}: method after keepalive")

    def test_the_api_locations_proxy_through_the_map_only(self) -> None:
        proxy = strip_comments(API_PROXY.read_text(encoding="utf-8"))
        self.assertEqual(re.findall(r"proxy_pass\s+([^;]+);", proxy), ["http://$vms_api_pool"])
        self.assertNotIn("proxy_pass", strip_comments(self.template))
        # The two API locations and the brand image upload nested in the first (`BrandUploadTests`).
        self.assertEqual(self.template.count("include /etc/nginx/snippets/api-proxy.conf;"), 3)

    def test_the_map_fits_its_hash_buckets_and_the_access_log_names_the_instance(self) -> None:
        # nginx's default bucket size is the CPU's cache line (32 bytes on some hosts), too small for
        # "GET /api/v1/reception/inside": `nginx -t` failed with "could not build map_hash".
        main = strip_comments(MAIN_CONF.read_text(encoding="utf-8"))
        bucket = re.search(r"\bmap_hash_bucket_size\s+(\d+);", main)
        self.assertIsNotNone(bucket)
        # One hash element: a pointer, a 2-byte length and the key, aligned to 8 bytes; plus the
        # bucket's terminating pointer (64-bit nginx).
        longest = max(len(key) for key in self.routes)
        self.assertGreaterEqual(int(bucket.group(1)), 8 + (2 + longest + 7) // 8 * 8 + 8)
        first_map = re.search(r"(?m)^\s*map\s", main)
        self.assertIsNotNone(first_map)
        self.assertLess(bucket.start(), first_map.start(), "map_hash_bucket_size must precede the first map")
        self.assertIn('"api_pool":"$proxy_host"', main)

    def test_the_startup_check_validates_every_instance_and_the_image_has_defaults(self) -> None:
        script = CHECK_SCRIPT.read_text(encoding="utf-8")
        defaults = image_env_defaults()
        self.assertIn("NGINX_ENVSUBST_FILTER", defaults)
        for variable, default in UPSTREAMS.values():
            self.assertRegex(script, rf'(?m)^check_upstream {variable} "\$\{{{variable}:-\}}" {default}$')
            self.assertEqual(defaults.get(variable), default, variable)
            self.assertIn(f"${{{variable}}}", self.template)


class BrandUploadTests(unittest.TestCase):
    """Phase 12 (B12-6): the upload of a company's brand image is the one request whose body may exceed
    MAX_REQUEST_BODY_BYTES. nginx refuses oversized bodies before the API does, so it must let exactly
    this one through, up to the API's own limit for it, and nothing else."""

    def setUp(self) -> None:
        self.template = TEMPLATE.read_text(encoding="utf-8")
        self.locations = api_locations(self.template)
        self.own, self.nested = self.locations["^~ /api/"]

    def api_limit(self) -> int:
        """`BRAND_ASSET_MAX_BYTES` of the backend."""
        source = BRAND_MODEL.read_text(encoding="utf-8")
        value = re.search(r"^BRAND_ASSET_MAX_BYTES = (\d+) \* (\d+)$", source, re.M)
        self.assertIsNotNone(value, "BRAND_ASSET_MAX_BYTES = <n> * <m> in backend/app/models/brand.py")
        return int(value[1]) * int(value[2])

    def default_limit(self) -> int:
        """`MAX_REQUEST_BODY_BYTES` of the deployment's settings."""
        value = re.search(r"^MAX_REQUEST_BODY_BYTES=(\d+)$", BACKEND_ENV.read_text(encoding="utf-8"), re.M)
        self.assertIsNotNone(value)
        return int(value[1])

    def upload_location(self) -> tuple[re.Pattern[str], list[str]]:
        self.assertEqual(len(self.nested), 1, "one nested location: the brand image upload")
        [(matcher, body)] = self.nested.items()
        # A case-sensitive regular expression on the whole path, as the API's routes are.
        match = re.fullmatch(r"~ (\^\S+\$)", matcher)
        self.assertIsNotNone(match, matcher)
        return re.compile(match[1]), body

    def test_the_upload_route_exists_and_the_api_s_other_puts_are_known(self) -> None:
        declared = backend_routes()
        self.assertIn(BRAND_UPLOAD, declared)
        self.assertEqual(
            sorted(route for route in declared if route.startswith("PUT ")), sorted([BRAND_UPLOAD, *OTHER_PUTS])
        )

    def test_the_location_matches_what_the_route_matches(self) -> None:
        pattern, _body = self.upload_location()
        route = route_pattern(BRAND_UPLOAD.split(" ", 1)[1]).pattern
        self.assertEqual(pattern.pattern, f"^{route}$")
        for path in (
            "/api/v1/platform/companies/3f0d3c7e-9d0a-4c56-8a51-0a3b6c1d2e4f/brand/assets/logo",
            "/api/v1/platform/companies/3f0d3c7e-9d0a-4c56-8a51-0a3b6c1d2e4f/brand/assets/logo_dark",
            "/api/v1/platform/companies/x/brand/assets/icon",
        ):
            self.assertIsNotNone(pattern.fullmatch(path), path)
        for path in (
            "/api/v1/platform/companies/x/brand/assets/logo/",
            "/api/v1/platform/companies/x/brand/assets/logo/extra",
            "/api/v1/platform/companies/x/brand/assets/",
            "/api/v1/platform/companies/x/brand/assets",
            "/api/v1/platform/companies/x/brand",
            "/api/v1/platform/companies/x/y/brand/assets/logo",
            "/api/v1/platform/companies//brand/assets/logo",
            "/api/v1/public/companies/x/brand/assets/logo",
            "/api/v2/platform/companies/x/brand/assets/logo",
            "/API/v1/platform/companies/x/brand/assets/logo",
            "/x/api/v1/platform/companies/x/brand/assets/logo",
        ):
            self.assertIsNone(pattern.fullmatch(path), path)

    def test_no_other_route_of_the_api_gets_the_larger_limit(self) -> None:
        # Every other route template, with each parameter filled in, misses the location (DELETE on the
        # same path removes an image and has no body).
        pattern, _body = self.upload_location()
        upload_path = BRAND_UPLOAD.split(" ", 1)[1]
        others = {route.split(" ", 1)[1] for route in backend_routes()} - {upload_path}
        self.assertGreater(len(others), 50)
        for template in sorted(others):
            for filling in ("x", "logo", "brand", "assets"):
                path = re.sub(r"\{[^}]+\}", filling, template)
                self.assertIsNone(pattern.fullmatch(path), f"{template} as {path}")

    def test_the_upload_s_limit_is_the_api_s_and_every_other_body_keeps_the_default(self) -> None:
        _pattern, body = self.upload_location()
        self.assertEqual(size_in_bytes(setting(body, "client_max_body_size")), self.api_limit())
        self.assertEqual(self.api_limit(), 512 * 1024)
        for matcher, (own, _nested) in self.locations.items():
            self.assertEqual(
                size_in_bytes(setting(own, "client_max_body_size")), self.default_limit(), matcher
            )
        main = strip_comments(MAIN_CONF.read_text(encoding="utf-8"))
        self.assertEqual(re.findall(r"\bclient_max_body_size\s+(\S+);", main), ["64k"])
        self.assertEqual(self.default_limit(), 64 * 1024)
        # The snippet both kinds of location include sets no limit of its own: nginx refuses a directive
        # given twice in one location, and a limit there would be the upload's too.
        self.assertNotIn("client_max_body_size", strip_comments(API_PROXY.read_text(encoding="utf-8")))

    def upload_places(self) -> dict[str, tuple[str, int]]:
        """What counts the uploads in progress: per zone, the value its key has for a counted request
        and the most requests it lets in at a time. The key of every zone must be a variable that is
        empty for every method but the upload's (nginx counts nothing under an empty key)."""
        _pattern, body = self.upload_location()
        limits = [directive.split()[1:] for directive in body if directive.split()[0] == "limit_conn"]
        declared = re.findall(
            r"^limit_conn_zone\s+(\S+)\s+zone=(\w+):\d+[km];", strip_comments(self.template), re.M
        )
        zones = {zone: key for key, zone in declared}
        self.assertEqual(len(zones), len(declared), "no zone is declared twice")
        self.assertEqual(sorted(zone for zone, _limit in limits), sorted(zones), "every zone is used, once")
        method = BRAND_UPLOAD.split(" ", 1)[0]
        places = {}
        for zone, limit in limits:
            entries = map_entries(self.template, "$request_method", zones[zone])
            self.assertEqual(len(entries), 2, f"{zones[zone]}: a default and the upload's method")
            self.assertIn('default "";', entries, zones[zone])
            [counted] = [entry for entry in entries if not entry.startswith("default")]
            counted_method, value = counted.rstrip(";").split()
            self.assertEqual(counted_method, method, zones[zone])
            places[zone] = (value, int(limit))
        return places

    def test_the_upload_s_body_is_passed_on_while_it_arrives_and_no_other_body_is(self) -> None:
        # B12-18. A place among the uploads in progress is taken before anyone is asked who they are.
        # With the body read by nginx first, a request kept its place for as long as its body took:
        # eight connections that sent one byte every few seconds held every place, and the platform
        # owner got 503. Passed on while it arrives, the request reaches the API with its header, and
        # the API answers whoever is not the platform owner without reading a byte of the body.
        _pattern, body = self.upload_location()
        self.assertEqual(setting(body, "proxy_request_buffering"), "off")
        # Every other request body is still read before the API sees the request: a slow client never
        # ties up an API worker.
        for matcher, (own, _nested) in self.locations.items():
            self.assertEqual(setting(own, "proxy_request_buffering"), "on", matcher)
        template = strip_comments(self.template)
        self.assertEqual(len(re.findall(r"\bproxy_request_buffering\s+off;", template)), 1)
        self.assertEqual(len(re.findall(r"\bproxy_request_buffering\b", template)), 3)
        # The snippet every API location includes has no line of its own: nginx refuses a directive
        # given twice in one location, and an `off` there would be every location's.
        proxy = strip_comments(API_PROXY.read_text(encoding="utf-8"))
        self.assertNotIn("proxy_request_buffering", proxy)
        # A body without a declared length can only be passed on as it arrives over HTTP/1.1.
        self.assertRegex(proxy, r"\bproxy_http_version\s+1\.1;")
        # nginx holds no body beyond its ordinary buffer, the upload's included: nothing in memory to
        # bound, nothing written under /tmp.
        self.assertFalse([d for d in body if d.startswith("client_body_buffer_size")])
        main = strip_comments(MAIN_CONF.read_text(encoding="utf-8"))
        self.assertEqual(re.findall(r"\bclient_body_buffer_size\s+(\S+);", main), ["64k"])
        self.assertNotIn("client_body_buffer_size", template)

    def test_the_api_bounds_the_time_of_a_body_that_nginx_no_longer_reads_first(self) -> None:
        # nginx's client_body_timeout is the longest pause between two reads, not a time for the body:
        # a signed-in client that sends a byte every few seconds would keep its place without end. The
        # API gives the whole body a time (408 after it).
        source = API_DEPENDENCIES.read_text(encoding="utf-8")
        seconds = re.search(r"^PNG_UPLOAD_SECONDS = (\d+(?:\.\d+)?)$", source, re.M)
        self.assertIsNotNone(seconds, "PNG_UPLOAD_SECONDS = <seconds> in backend/app/api/deps.py")
        self.assertTrue(0 < float(seconds[1]) <= 60, seconds[1])
        self.assertRegex(source, r"anyio\.fail_after\(PNG_UPLOAD_SECONDS\)")
        main = strip_comments(MAIN_CONF.read_text(encoding="utf-8"))
        self.assertRegex(main, r"\bclient_body_timeout\s+15s;")

    def test_only_an_upload_takes_a_place_and_no_address_takes_them_all(self) -> None:
        # Counted for the whole site and per client address. The location matches the path whatever the
        # method, and DELETE on it removes an image: only PUT is counted, so a removal is never refused
        # because uploads are in progress (`upload_places` holds the keys to that).
        places = self.upload_places()
        self.assertEqual(
            sorted(places.values()),
            sorted(
                [
                    ("$server_name", MAX_UPLOADS_IN_PROGRESS),
                    ("$binary_remote_addr", MAX_UPLOADS_PER_ADDRESS),
                ]
            ),
        )
        # One address cannot have more than half the places, and has room for a page that saves a
        # company's three images and for a colleague behind the same address.
        self.assertLessEqual(2 * MAX_UPLOADS_PER_ADDRESS, MAX_UPLOADS_IN_PROGRESS)
        self.assertGreaterEqual(MAX_UPLOADS_PER_ADDRESS, 2)
        # No other use of a counted variable: a key that named the method elsewhere would count it.
        template = strip_comments(self.template)
        self.assertEqual(len(re.findall(r"\blimit_conn_zone\b", template)), 2)
        self.assertEqual(len(re.findall(r"\blimit_conn\s", template)), 2)
        self.assertNotRegex(template, r"\blimit_conn_zone\s+\$(server_name|binary_remote_addr|remote_addr)\b")
        # One more upload than there are places gets 503 in the API's envelope.
        proxy = strip_comments(API_PROXY.read_text(encoding="utf-8"))
        self.assertRegex(proxy, r"error_page\s+502\s+503\s+504\s+=\s+@api_unavailable;")
        self.assertRegex(proxy, r"error_page\s+413\s+=\s+@api_payload_too_large;")
        self.assertNotRegex(template + proxy, r"\blimit_conn_status\b")  # nginx's default: 503

    def test_a_request_gives_its_place_back_with_its_answer(self) -> None:
        # With lingering_close on (nginx's default), nginx keeps a request whose body it did not read
        # to the end for up to 30 s after the answer, as long as the client keeps sending, and the
        # request keeps its place: strangers who opened a new connection every half minute still held
        # every place (measured with nginx 1.30.5). In the upload's location the connection is closed
        # with the answer; everywhere else nginx's default stays, where nothing is counted.
        _pattern, body = self.upload_location()
        self.assertEqual(setting(body, "lingering_close"), "off")
        everything = "\n".join(
            strip_comments(path.read_text(encoding="utf-8"))
            for path in (TEMPLATE, MAIN_CONF, *sorted((NGINX / "snippets").glob("*.conf")))
        )
        self.assertEqual(re.findall(r"\blingering_\w+\s+[^;]+;", everything), ["lingering_close off;"])

    def test_the_upload_s_location_is_this_and_nothing_else(self) -> None:
        _pattern, body = self.upload_location()
        places = self.upload_places()
        self.assertEqual(
            sorted(body),
            sorted(
                [
                    "include /etc/nginx/snippets/api-proxy.conf",
                    "client_max_body_size 512k",
                    "proxy_request_buffering off",
                    "lingering_close off",
                    *(f"limit_conn {zone} {limit}" for zone, (_value, limit) in places.items()),
                ]
            ),
        )

    def test_nginx_sets_no_caching_rule_for_the_public_endpoints(self) -> None:
        # The API alone says how long a public answer may be kept (B12-9): a year for an image under the
        # address of its current version, a minute under any other, `no-cache` for the identity and the
        # manifest, `no-store` for every error. nginx passes that through: no add_header, no expires, no
        # proxy cache anywhere on the way to the API.
        proxy = strip_comments(API_PROXY.read_text(encoding="utf-8"))
        for directive in ("add_header", "expires", "proxy_cache", "proxy_hide_header", "proxy_store"):
            self.assertNotRegex(proxy, rf"\b{directive}\b", directive)
            for _matcher, (own, nested) in self.locations.items():
                every = own + [d for inner in nested.values() for d in inner]
                self.assertFalse([d for d in every if d.startswith(directive)], directive)
        self.assertRegex(proxy, r"\bgzip\s+off;")


def mebibytes(value: str) -> int:
    """A compose memory limit (512m, 1g) or a PostgreSQL size (16MB, 1GB) in MiB."""
    number = re.fullmatch(r"(\d+)([mg]|MB|GB)", value)
    if not number:
        raise AssertionError(f"unexpected size {value!r}")
    return int(number[1]) * (1024 if number[2] in ("g", "GB") else 1)


def replicas(service: dict) -> int:
    """The number of processes compose runs for a service (`deploy.replicas`, else `scale`, else 1)."""
    return int(service.get("deploy", {}).get("replicas", service.get("scale", 1)))


def seconds(value: str) -> int:
    match = re.fullmatch(r"(?:(\d+)m)?(?:(\d+)s)?", value)
    if not (match and value):
        raise AssertionError(f"unexpected compose duration {value!r}")
    return int(match[1] or 0) * 60 + int(match[2] or 0)


def environment(service: dict) -> dict[str, str | None]:
    """A service's compose `environment` in either syntax ({KEY: value} or ["KEY=value"]). A key without a
    value takes the value of the shell that runs compose: None here."""
    entries = service.get("environment") or {}
    if isinstance(entries, dict):
        return {key: None if value is None else str(value) for key, value in entries.items()}
    return {key: value[0] if value else None for key, *value in (entry.split("=", 1) for entry in entries)}


def shared_settings(service: dict) -> dict[str, str | None]:
    """A service's `environment` without the keys a read service may set to a value of its own."""
    return {key: value for key, value in environment(service).items() if key not in READ_SERVICE_OVERRIDES}


@unittest.skipIf(yaml is None, "PyYAML is not installed: run with the backend's environment")
class ComposeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.services = yaml.safe_load(COMPOSE.read_text(encoding="utf-8"))["services"]
        names = [default.split(":")[0] for _variable, default in UPSTREAMS.values()]
        self.api = {name: self.services[name] for name in names}
        self.env = dict(re.findall(r"(?m)^([A-Z_]+)=(.*)$", BACKEND_ENV.read_text(encoding="utf-8")))

    def setting(self, service: dict, name: str) -> str:
        """The value an API container sees: compose `environment` overrides backend.env."""
        return str(environment(service).get(name, self.env[name]))

    def test_the_main_instance_is_one_process_and_the_lists_have_replicas(self) -> None:
        # Every budget but the per-user API budget is counted only by the main instance: a second
        # process of it would double them all (security audit R-1). The read services consult only the
        # per-user API budget, which each replica counts for the requests nginx sends it.
        backend = self.services["backend"]
        self.assertNotIn("scale", backend)
        self.assertEqual(replicas(backend), 1)
        self.assertGreaterEqual(replicas(self.services["backend-reception"]), MIN_LIST_REPLICAS)
        for name, service in self.api.items():
            if replicas(service) > 1:
                # Only a read pool whose nginx group balances its servers may have replicas.
                group = next(group for group, (_v, default) in UPSTREAMS.items() if default == f"{name}:8000")
                self.assertIn(group, BALANCED, name)

    def test_each_upstream_default_is_an_api_service_of_the_same_image(self) -> None:
        backend = self.services["backend"]
        for name, service in self.api.items():
            with self.subTest(service=name):
                self.assertEqual(service["image"], backend["image"])
                self.assertEqual(service.get("build"), backend.get("build"))
                self.assertIn("8000", [str(port) for port in service.get("expose", [])])

    def test_every_api_instance_has_the_hardening_and_the_shutdown_of_the_main_one(self) -> None:
        for name, service in self.api.items():
            with self.subTest(service=name):
                # The image's command (python -m app.serve, one worker) under an init: the re-raised
                # SIGTERM must be able to end the process (D9-32).
                self.assertNotIn("command", service)
                self.assertNotIn("entrypoint", service)
                self.assertIs(service.get("init"), True)
                self.assertGreaterEqual(seconds(service["stop_grace_period"]), MIN_STOP_GRACE_SECONDS)
                self.assertIs(service.get("read_only"), True)
                self.assertEqual(service.get("cap_drop"), ["ALL"])
                self.assertIn("no-new-privileges:true", service.get("security_opt", []))
                self.assertNotIn("ports", service)
                self.assertEqual(sorted(service["networks"]), ["app", "db"])
                # The owner's URL (migrate.env) never reaches an API container (D9-23).
                env_files = [entry["path"] for entry in service["env_file"]]
                self.assertEqual(env_files, ["deploy/env/backend.env"])
                migrate = service["depends_on"]["migrate"]["condition"]
                self.assertEqual(migrate, "service_completed_successfully")
                self.assertTrue(service["deploy"]["resources"]["limits"].get("pids"))

    def test_the_read_services_share_the_program_and_the_settings_of_the_main_one(self) -> None:
        # Security review condition 4: the four processes run one program on one configuration, and only
        # the keys of READ_SERVICE_OVERRIDES may differ. `<<: *api` merges one level deep: an
        # `environment` added to the anchor would reach `backend` alone, since each read service replaces
        # it with its own.
        main = self.services["backend"]
        allowed = " and ".join(sorted(READ_SERVICE_OVERRIDES))
        for name, service in self.api.items():
            if name == "backend":
                continue
            with self.subTest(service=name):
                for key in ("image", "build", "command", "entrypoint", "env_file"):
                    self.assertEqual(service.get(key), main.get(key), f"{name}: `{key}` is not backend's")
                overridden = sorted(set(environment(service)) - READ_SERVICE_OVERRIDES)
                self.assertEqual(overridden, [], f"{name} may override only {allowed} in `environment`")
                self.assertEqual(
                    shared_settings(service),
                    shared_settings(main),
                    f"{name} (first) and backend (second) must set the same `environment` outside {allowed}; "
                    "a key that one of them does not set takes the env file's value there",
                )

    def test_nginx_waits_for_every_instance(self) -> None:
        depends = self.services["frontend"]["depends_on"]
        for name in self.api:
            self.assertEqual(depends.get(name, {}).get("condition"), "service_healthy", name)

    def test_argon2_slots_fit_each_memory_limit(self) -> None:
        for name, service in self.api.items():
            with self.subTest(service=name):
                slots = int(self.setting(service, "PASSWORD_HASH_CONCURRENCY"))
                limit = mebibytes(service["deploy"]["resources"]["limits"]["memory"])
                caps = LIMITER_CAPS_MIB if name == "backend" else 0
                self.assertLessEqual(slots * ARGON2_MIB + APPLICATION_MIB + caps, limit)

    def test_database_connections_fit_the_postgres_settings(self) -> None:
        # Each process opens at most DB_POOL_SIZE + the same again as overflow (app/db/session.py).
        connections = 0
        for service in self.api.values():
            connections += 2 * int(self.setting(service, "DB_POOL_SIZE")) * replicas(service)
        postgres = self.services["postgres"]
        settings = dict(arg.split("=", 1) for arg in postgres["command"] if "=" in arg)
        self.assertLessEqual(connections, int(settings.get("max_connections", "100")) - 10)
        # Shared buffers, one sort or hash step per API connection, and autovacuum (3 x 64MB): the
        # budget of D9-31, which the compose comment above `work_mem` states.
        budget = (
            mebibytes(settings["shared_buffers"]) + connections * mebibytes(settings["work_mem"]) + 3 * 64
        )
        self.assertLessEqual(budget, mebibytes(postgres["deploy"]["resources"]["limits"]["memory"]))
        self.assertIn(f"at most {connections} API connections", COMPOSE.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
