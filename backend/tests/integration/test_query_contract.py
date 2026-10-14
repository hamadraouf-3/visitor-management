"""Query parameters come from the contract's query models (contract §3.2-9, §8): every route that takes
query parameters declares exactly the parameters of its model in `app.contract.QUERY_ROUTES`, so a later
phase cannot add, rename or retype a filter without the snapshot (and the frontend mirror) following."""

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import contract
from tests.support import Api, World, error_code


def _query_parameters(app: FastAPI) -> dict[tuple[str, str], set[str]]:
    declared: dict[tuple[str, str], set[str]] = {}
    for path, operations in app.openapi()["paths"].items():
        for method, operation in operations.items():
            names = {param["name"] for param in operation.get("parameters", []) if param["in"] == "query"}
            if names:
                declared[(method.upper(), path)] = names
    return declared


def test_every_route_with_query_parameters_uses_its_contract_model(shared_app: FastAPI) -> None:
    declared = _query_parameters(shared_app)
    unlisted = sorted(set(declared) - set(contract.QUERY_ROUTES))
    assert unlisted == [], f"add these routes and their query models to app.contract.QUERY_ROUTES: {unlisted}"
    for route, names in declared.items():
        model = contract.QUERY_ROUTES[route]
        expected = {field.alias or name for name, field in model.model_fields.items()}
        assert names == expected, f"{route} must declare exactly the parameters of {model.__name__}"


def test_the_implemented_query_routes_are_checked(shared_app: FastAPI) -> None:
    # Guards the test above against passing vacuously.
    assert {("GET", "/api/v1/users"), ("GET", "/api/v1/users/hosts"), ("GET", "/api/v1/departments")} <= set(
        _query_parameters(shared_app)
    )


def test_every_query_model_is_published_under_its_typescript_name() -> None:
    assert set(contract.QUERY_ROUTES.values()) <= set(contract.QUERIES.values())
    assert all(name.endswith("Params") for name in contract.QUERIES)
    assert set(contract.build()["queries"]) == set(contract.QUERIES)


# ---- through HTTP -------------------------------------------------------------------------------


def _admin(client: TestClient, world: World) -> Api:
    api = Api(client)
    assert api.login(world.a.admin.email).status_code == 200
    return api


def test_unknown_query_parameter_is_a_field_error(client: TestClient, world: World) -> None:
    response = _admin(client, world).get("/users", params={"sort": "name"})
    assert response.status_code == 422
    assert response.json()["error"]["details"] == {
        "fields": {"sort": "This field is not allowed."},
        "field_codes": {"sort": {"code": "not_allowed", "params": {}}},
    }


def test_role_filter_takes_comma_separated_and_repeated_values(client: TestClient, world: World) -> None:
    api = _admin(client, world)
    by_comma = api.get("/users", params={"role": "RECEPTIONIST,MANAGEMENT"}).json()["items"]
    repeated = api.get("/users", params=[("role", "RECEPTIONIST"), ("role", "MANAGEMENT")]).json()["items"]
    expected = {str(world.a.receptionist.id), str(world.a.manager.id)}
    assert {item["id"] for item in by_comma} == {item["id"] for item in repeated} == expected


def test_unknown_role_is_a_field_error_naming_the_choices(client: TestClient, world: World) -> None:
    response = _admin(client, world).get("/users", params={"role": "EMPLOYEE,JANITOR"})
    assert response.status_code == 422
    assert response.json()["error"]["details"]["fields"] == {
        "role": "Choose one of: 'SYSTEM_ADMIN', 'EMPLOYEE', 'RECEPTIONIST' or 'MANAGEMENT'."
    }


def test_authorization_is_decided_before_query_validation(make_client, world: World) -> None:
    anonymous = Api(make_client())
    assert anonymous.get("/users", params={"sort": "x"}).status_code == 401
    employee = Api(make_client())
    employee.login(world.a.employee.email)
    denied = employee.get("/users", params={"sort": "x"})
    assert denied.status_code == 403 and error_code(denied) == "FORBIDDEN"


def test_boolean_query_parameters_are_validated(client: TestClient, world: World) -> None:
    response = _admin(client, world).get("/departments", params={"include_inactive": "maybe"})
    assert response.status_code == 422
    assert response.json()["error"]["details"]["fields"] == {"include_inactive": "Choose true or false."}
