from datetime import timedelta

import pytest
from sqlalchemy.orm import Session

from app.models import Company, Department, Visit
from app.repositories.departments import DepartmentRepository
from tests.conftest import TEST_START
from tests.support import (
    Api,
    World,
    audit_rows,
    check_in,
    create_visit,
    error_code,
    refreshed,
    signed_in,
    walk_in_body,
)


@pytest.fixture
def admin(make_client, world: World) -> Api:
    api = Api(make_client())
    api.login(world.a.admin.email)
    return api


@pytest.fixture
def employee(make_client, world: World) -> Api:
    api = Api(make_client())
    api.login(world.a.employee.email)
    return api


# ---- departments --------------------------------------------------------------------------------


def test_list_departments_active_only_for_everyone(employee: Api, world: World) -> None:
    response = employee.get("/departments")
    assert response.status_code == 200
    assert [d["name"] for d in response.json()] == ["Finance"]
    assert set(response.json()[0]) == {
        "id",
        "name",
        "name_ar",
        "is_active",
        "created_at",
        "updated_at",
        "floor",  # Phase 16 (B16-3): the department's floor, null without one
    }
    assert response.json()[0]["floor"] is None


def test_include_inactive_is_admin_only(admin: Api, employee: Api, db: Session, world: World) -> None:
    assert [d["name"] for d in admin.get("/departments", params={"include_inactive": "true"}).json()] == [
        "Finance",
        "Legacy",
    ]
    denied = employee.get("/departments", params={"include_inactive": "true"})
    assert denied.status_code == 403
    assert error_code(denied) == "FORBIDDEN"
    rows = audit_rows(db, "ACCESS_DENIED", actor_user_id=world.a.employee.id)
    assert rows[-1].meta == {"method": "GET", "route": "/api/v1/departments"}


def test_create_department_and_conflicts(admin: Api, world: World, db: Session) -> None:
    created = admin.post("/departments", json={"name": "  Security  "})
    assert created.status_code == 201
    assert created.json()["name"] == "Security" and created.json()["is_active"] is True
    assert len(audit_rows(db, "DEPARTMENT_CREATED", entity_id=created.json()["id"])) == 1

    duplicate = admin.post("/departments", json={"name": "SECURITY"})
    assert duplicate.status_code == 409
    assert duplicate.json()["error"]["code"] == "CONFLICT"
    assert duplicate.json()["error"]["details"] == {"field": "name"}
    inactive_duplicate = admin.post("/departments", json={"name": "legacy"})
    assert inactive_duplicate.status_code == 409


def test_same_department_name_in_another_company_is_fine(admin: Api) -> None:
    # "Finance" exists in both companies of the test world already; another name works too.
    assert admin.post("/departments", json={"name": "Bravo-only name"}).status_code == 201


def test_update_department(admin: Api, world: World, db: Session) -> None:
    response = admin.patch(
        f"/departments/{world.a.finance.id}", json={"name": "Treasury", "is_active": False}
    )
    assert response.status_code == 200
    assert response.json()["name"] == "Treasury" and response.json()["is_active"] is False
    rows = audit_rows(db, "DEPARTMENT_UPDATED", entity_id=world.a.finance.id)
    assert rows[-1].meta == {"changed_fields": ["name", "is_active"]}

    conflict = admin.patch(f"/departments/{world.a.legacy.id}", json={"name": "treasury"})
    assert conflict.status_code == 409
    same = admin.patch(f"/departments/{world.a.legacy.id}", json={"name": "Legacy"})
    assert same.status_code == 200


def test_department_of_other_company_is_not_found(admin: Api, world: World) -> None:
    assert admin.patch(f"/departments/{world.b.finance.id}", json={"name": "X"}).status_code == 404


def test_department_validation(admin: Api, world: World) -> None:
    assert admin.post("/departments", json={"name": ""}).status_code == 422
    assert admin.post("/departments", json={"name": "x" * 121}).status_code == 422
    null_name = admin.patch(f"/departments/{world.a.finance.id}", json={"name": None})
    assert null_name.status_code == 422


# ---- company settings ---------------------------------------------------------------------------


def test_company_settings_readable_by_every_role(make_client, world: World) -> None:
    for user in world.a.users_by_role.values():
        api = Api(make_client())
        api.login(user.email)
        response = api.get("/company/settings")
        assert response.status_code == 200
        assert response.json() == {
            "id": str(world.a.company.id),
            "name": "Alpha",
            "name_ar": None,
            "default_language": "en",
            "timezone": "Asia/Amman",
            "address": None,
            "address_ar": None,
            "email_domain": None,
            "pass_grace_before_minutes": 60,
            "pass_grace_after_minutes": 60,
            "notify_host_on_check_in": True,
            "allow_walk_ins": True,
        }


def test_update_company_settings(admin: Api, world: World, db: Session) -> None:
    response = admin.patch(
        "/company/settings",
        json={
            "name": "Alpha Holdings",
            "timezone": "Europe/London",
            "address": "  1 Main Street  ",
            "email_domain": "@Alpha.Example",
            "pass_grace_before_minutes": 0,
            "pass_grace_after_minutes": 1440,
            "notify_host_on_check_in": False,
            "allow_walk_ins": False,
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["timezone"] == "Europe/London"
    assert body["address"] == "1 Main Street"
    assert body["email_domain"] == "alpha.example"
    assert body["pass_grace_after_minutes"] == 1440
    rows = audit_rows(db, "COMPANY_SETTINGS_UPDATED", entity_id=world.a.company.id)
    assert len(rows[-1].meta["changed_fields"]) == 8

    cleared = admin.patch("/company/settings", json={"address": "", "email_domain": None})
    assert cleared.json()["address"] is None and cleared.json()["email_domain"] is None
    assert refreshed(db, Company, world.b.company.id).name == "Bravo"  # other tenant untouched


@pytest.mark.parametrize(
    ("payload", "field"),
    [
        ({"timezone": "Mars/Olympus_Mons"}, "timezone"),
        ({"timezone": "../../etc/passwd"}, "timezone"),
        ({"pass_grace_before_minutes": -1}, "pass_grace_before_minutes"),
        ({"pass_grace_after_minutes": 1441}, "pass_grace_after_minutes"),
        ({"email_domain": "not a domain"}, "email_domain"),
        ({"name": None}, "name"),
        ({"allow_walk_ins": None}, "allow_walk_ins"),
        # B10-2: the Arabic name follows the rules of `name`; the default language is ar or en, never null.
        ({"name_ar": "x" * 201}, "name_ar"),
        ({"name_ar": "\u0645\u0648\u0636\u0648\u0639\nBcc: x"}, "name_ar"),
        ({"name_ar": "\u0645\u202e\u0648\u0636\u0648\u0639"}, "name_ar"),
        ({"name_ar": "\u0645\u0648\u0636\u0648\u0639\x07"}, "name_ar"),
        ({"name_ar": 7}, "name_ar"),
        ({"default_language": "fr"}, "default_language"),
        ({"default_language": "AR"}, "default_language"),
        ({"default_language": None}, "default_language"),
    ],
)
def test_company_settings_validation(admin: Api, payload: dict, field: str) -> None:
    response = admin.patch("/company/settings", json=payload)
    assert response.status_code == 422
    assert field in response.json()["error"]["details"]["fields"]


def test_timezone_must_be_known_to_postgres(admin: Api, monkeypatch) -> None:
    # A zone Python knows but the database does not (simulated) is rejected.
    from app.repositories.companies import CompanyRepository

    monkeypatch.setattr(CompanyRepository, "database_knows_timezone", lambda self, name: False)
    response = admin.patch("/company/settings", json={"timezone": "Europe/Paris"})
    assert response.status_code == 422


def test_unchanged_settings_write_no_audit(admin: Api, world: World, db: Session) -> None:
    assert admin.patch("/company/settings", json={"timezone": "Asia/Amman"}).status_code == 200
    assert audit_rows(db, "COMPANY_SETTINGS_UPDATED", company_id=world.a.company.id) == []


# ---- the Arabic name and the default language (Phase 10, B10-2) -----------------------------------


def test_the_arabic_name_and_default_language_are_settings(admin: Api, world: World, db: Session) -> None:
    response = admin.patch(
        "/company/settings", json={"name_ar": "  ألفا القابضة  ", "default_language": "ar"}
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["name_ar"] == "ألفا القابضة" and body["default_language"] == "ar"
    assert body["name"] == "Alpha"  # the English name is a separate setting
    stored = refreshed(db, Company, world.a.company.id)
    assert (stored.name_ar, stored.default_language) == ("ألفا القابضة", "ar")
    # Audited like every setting: the changed field names, never the values.
    (row,) = audit_rows(db, "COMPANY_SETTINGS_UPDATED", entity_id=world.a.company.id)
    assert row.meta == {"changed_fields": ["name_ar", "default_language"]}
    # Every member of the company sees them in the Me payload.
    me = Api(admin.client).get("/auth/me").json()["company"]
    assert (me["name_ar"], me["default_language"]) == ("ألفا القابضة", "ar")
    # A blank Arabic name, or null, clears it; the other tenant is untouched.
    assert admin.patch("/company/settings", json={"name_ar": "   "}).json()["name_ar"] is None
    assert admin.patch("/company/settings", json={"name_ar": "ألفا"}).json()["name_ar"] == "ألفا"
    assert admin.patch("/company/settings", json={"name_ar": None}).json()["name_ar"] is None
    other = refreshed(db, Company, world.b.company.id)
    assert (other.name_ar, other.default_language) == (None, "en")


def test_the_arabic_name_is_at_most_200_characters(admin: Api) -> None:
    assert admin.patch("/company/settings", json={"name_ar": "م" * 200}).status_code == 200
    assert admin.patch("/company/settings", json={"name_ar": "م" * 201}).status_code == 422


def test_only_administrators_change_the_languages(make_client, world: World, db: Session) -> None:
    for user in (world.a.employee, world.a.receptionist, world.a.manager):
        api = Api(make_client())
        api.login(user.email)
        response = api.patch("/company/settings", json={"default_language": "ar", "name_ar": "ألفا"})
        assert response.status_code == 403 and error_code(response) == "FORBIDDEN"
    stored = refreshed(db, Company, world.a.company.id)
    assert (stored.name_ar, stored.default_language) == (None, "en")


# ---- the Arabic name of a department and the Arabic address (B10-25) --------------------------------


def test_a_department_is_created_with_its_arabic_name(admin: Api, world: World, db: Session) -> None:
    created = admin.post("/departments", json={"name": "  Security ", "name_ar": "  الأمن  "})
    assert created.status_code == 201, created.text
    body = created.json()
    assert (body["name"], body["name_ar"]) == ("Security", "الأمن")
    stored = refreshed(db, Department, body["id"])
    assert (stored.name, stored.name_ar) == ("Security", "الأمن")
    # Without one, or with a blank one, it has none.
    assert admin.post("/departments", json={"name": "Legal"}).json()["name_ar"] is None
    assert admin.post("/departments", json={"name": "Audit", "name_ar": "   "}).json()["name_ar"] is None
    assert admin.post("/departments", json={"name": "Press", "name_ar": None}).json()["name_ar"] is None
    # Every reader gets it in the list.
    listed = {d["name"]: d["name_ar"] for d in admin.get("/departments").json()}
    assert listed["Security"] == "الأمن" and listed["Finance"] is None


def test_an_arabic_name_is_unique_per_company_ignoring_case(admin: Api, world: World, factory) -> None:
    assert admin.post("/departments", json={"name": "Security", "name_ar": "الأمن"}).status_code == 201
    duplicate = admin.post("/departments", json={"name": "Safety", "name_ar": "الأمن"})
    assert duplicate.status_code == 409
    assert duplicate.json()["error"] == {
        "code": "CONFLICT",
        "message": "A department with this Arabic name already exists.",
        "details": {"field": "name_ar"},
    }
    # Ignoring case, for an Arabic name written in Latin letters too.
    assert admin.post("/departments", json={"name": "Desk A", "name_ar": "Mktb"}).status_code == 201
    assert admin.post("/departments", json={"name": "Desk B", "name_ar": "MKTB"}).status_code == 409
    # A name that is taken is reported on `name` first.
    both = admin.post("/departments", json={"name": "SECURITY", "name_ar": "الأمن"})
    assert both.status_code == 409 and both.json()["error"]["details"] == {"field": "name"}
    # An inactive department's Arabic name is taken as well; another company's is not.
    factory.department(world.a.company, "Archive", is_active=False, name_ar="الأرشيف")
    assert admin.post("/departments", json={"name": "Records", "name_ar": "الأرشيف"}).status_code == 409
    factory.department(world.b.company, "Logistics", name_ar="اللوجستيات")
    assert admin.post("/departments", json={"name": "Logistics", "name_ar": "اللوجستيات"}).status_code == 201
    # Many departments may have none.
    assert admin.post("/departments", json={"name": "Legal"}).status_code == 201
    assert admin.post("/departments", json={"name": "Press"}).status_code == 201


def test_a_concurrent_duplicate_arabic_name_is_a_conflict_on_name_ar(
    admin: Api, world: World, db: Session, monkeypatch
) -> None:
    """Two administrators adding the same Arabic name at once: the second insert, or update, past the
    service's own check meets the unique index and answers the same 409 (B10-25)."""
    assert admin.post("/departments", json={"name": "Security", "name_ar": "الأمن"}).status_code == 201
    monkeypatch.setattr(DepartmentRepository, "get_by_name_ar", lambda self, company_id, name_ar: None)
    for response in (
        admin.post("/departments", json={"name": "Safety", "name_ar": "الأمن"}),
        admin.patch(f"/departments/{world.a.finance.id}", json={"name_ar": "الأمن"}),
    ):
        assert response.status_code == 409
        assert response.json()["error"]["details"] == {"field": "name_ar"}
    assert refreshed(db, Department, world.a.finance.id).name_ar is None


def test_the_arabic_name_is_changed_and_cleared_and_audited(admin: Api, world: World, db: Session) -> None:
    finance = world.a.finance
    renamed = admin.patch(f"/departments/{finance.id}", json={"name_ar": "المالية"})
    assert renamed.status_code == 200, renamed.text
    assert (renamed.json()["name"], renamed.json()["name_ar"]) == ("Finance", "المالية")
    # The same value again changes nothing and is not audited.
    assert admin.patch(f"/departments/{finance.id}", json={"name_ar": "المالية"}).status_code == 200
    assert (
        admin.patch(f"/departments/{finance.id}", json={"name": "Finance", "is_active": True}).json()[
            "name_ar"
        ]
        == "المالية"
    )  # omitted: unchanged
    cleared = admin.patch(f"/departments/{finance.id}", json={"name_ar": None})
    assert cleared.status_code == 200 and cleared.json()["name_ar"] is None
    blank = admin.patch(f"/departments/{finance.id}", json={"name_ar": "  "})
    assert blank.status_code == 200 and blank.json()["name_ar"] is None
    both = admin.patch(f"/departments/{finance.id}", json={"name": "Treasury", "name_ar": "الخزينة"})
    assert both.status_code == 200
    rows = audit_rows(db, "DEPARTMENT_UPDATED", entity_id=finance.id)
    assert [(row.actor_user_id, row.meta) for row in rows] == [
        (world.a.admin.id, {"changed_fields": ["name_ar"]}),
        (world.a.admin.id, {"changed_fields": ["name_ar"]}),
        (world.a.admin.id, {"changed_fields": ["name", "name_ar"]}),
    ]
    # Audit metadata never holds the names themselves.
    assert all("الخزينة" not in str(row.meta) for row in rows)
    # Another department's Arabic name is taken; its own is not.
    assert admin.patch(f"/departments/{world.a.legacy.id}", json={"name_ar": "الخزينة"}).status_code == 409
    assert admin.patch(f"/departments/{finance.id}", json={"name_ar": "الخزينة"}).status_code == 200


@pytest.mark.parametrize(
    "name_ar",
    [
        "م" * 121,
        "المالية\nBcc: x",
        "الما\u202eلية",
        "المالية\x07",
        "المالية" + "\t" + "العامة",
        7,
    ],
    ids=["too_long", "line_break", "bidi_control", "control", "tab", "not_text"],
)
def test_the_arabic_name_follows_the_rules_of_the_name(admin: Api, world: World, name_ar: object) -> None:
    for response in (
        admin.post("/departments", json={"name": "Security", "name_ar": name_ar}),
        admin.patch(f"/departments/{world.a.finance.id}", json={"name_ar": name_ar}),
    ):
        assert response.status_code == 422
        assert set(response.json()["error"]["details"]["fields"]) == {"name_ar"}


def test_the_arabic_name_is_at_most_120_characters(admin: Api, world: World) -> None:
    assert admin.post("/departments", json={"name": "Long", "name_ar": "م" * 120}).status_code == 201
    too_long = admin.patch(f"/departments/{world.a.finance.id}", json={"name_ar": "م" * 121})
    assert too_long.json()["error"]["details"]["field_codes"] == {
        "name_ar": {"code": "too_long", "params": {"max": 120}}
    }


def test_only_administrators_name_departments_in_arabic(make_client, world: World, db: Session) -> None:
    for user in (world.a.employee, world.a.receptionist, world.a.manager):
        api = Api(make_client())
        api.login(user.email)
        response = api.patch(f"/departments/{world.a.finance.id}", json={"name_ar": "المالية"})
        assert response.status_code == 403 and error_code(response) == "FORBIDDEN"
        created = api.post("/departments", json={"name": "X", "name_ar": "س"})
        assert created.status_code == 403
    assert refreshed(db, Department, world.a.finance.id).name_ar is None


def test_every_embedded_department_carries_its_arabic_name(
    admin: Api, make_client, world: World, factory
) -> None:
    """DepartmentRef everywhere a department is embedded: the caller's own (Me), users, the host
    directory, visits and their lists, reception, the evacuation list, visitor history, reports."""
    assert admin.patch(f"/departments/{world.a.finance.id}", json={"name_ar": "المالية"}).status_code == 200
    expected = {"id": str(world.a.finance.id), "name": "Finance", "name_ar": "المالية"}
    host = factory.user(world.a.company, full_name="Finance Host", department=world.a.finance)
    host_api = signed_in(make_client, host)
    assert host_api.get("/auth/me").json()["user"]["department"] == expected
    assert admin.get(f"/users/{host.id}").json()["department"] == expected
    assert {h["id"]: h["department"] for h in host_api.get("/users/hosts").json()}[str(host.id)] == expected

    start = TEST_START + timedelta(minutes=30)
    created = create_visit(host_api, host.id, start)
    visit_id, visitor_id = created["visit"]["id"], created["visit"]["visitor"]["id"]
    assert created["visit"]["department"] == expected
    assert host_api.get(f"/visits/{visit_id}").json()["department"] == expected
    assert host_api.get("/visits").json()["items"][0]["department"] == expected
    assert host_api.get(f"/visitors/{visitor_id}/visits").json()["items"][0]["department"] == expected
    assert host_api.get("/dashboard/employee").json()["today"][0]["department"] == expected
    reception = signed_in(make_client, world.a.receptionist)
    assert reception.get("/reception/today").json()["expected"][0]["department"] == expected
    scan = reception.post("/reception/scan", json={"token": created["pass_url"]})
    assert scan.status_code == 200 and scan.json()["visit"]["department"] == expected
    assert check_in(reception, visit_id).json()["department"] == expected
    inside = reception.get("/reception/inside").json()["items"]
    assert [item["department"] for item in inside] == [expected]
    walk_in = reception.post(
        "/reception/walk-ins", json=walk_in_body(host.id, TEST_START + timedelta(hours=1))
    )
    assert walk_in.status_code == 201 and walk_in.json()["department"] == expected
    report = signed_in(make_client, world.a.manager).get("/reports/summary").json()
    assert {
        "department_id": str(world.a.finance.id),
        "name": "Finance",
        "name_ar": "المالية",
        "count": 2,
    } in report["by_department"]


def test_a_department_s_arabic_name_reaches_its_scheduled_visits_only(
    admin: Api, make_client, world: World, factory, db: Session
) -> None:
    """D-17 for the Arabic name: the snapshots of SCHEDULED visits follow a change in either language;
    a visit checked in keeps the names it had."""
    host = factory.user(world.a.company, department=world.a.finance)
    host_api = signed_in(make_client, host)
    scheduled = create_visit(host_api, host.id, TEST_START + timedelta(hours=2))["visit"]["id"]
    inside = create_visit(host_api, host.id, TEST_START + timedelta(minutes=10))["visit"]["id"]
    assert check_in(signed_in(make_client, world.a.receptionist), inside).status_code == 200

    assert admin.patch(f"/departments/{world.a.finance.id}", json={"name_ar": "المالية"}).status_code == 200

    def names(visit_id: str) -> tuple[str | None, str | None]:
        visit = refreshed(db, Visit, visit_id)
        return visit.department_name, visit.department_name_ar

    assert names(scheduled) == ("Finance", "المالية")
    assert names(inside) == ("Finance", None)
    assert admin.patch(f"/departments/{world.a.finance.id}", json={"name": "Treasury"}).status_code == 200
    assert names(scheduled) == ("Treasury", "المالية")
    assert admin.patch(f"/departments/{world.a.finance.id}", json={"name_ar": None}).status_code == 200
    assert names(scheduled) == ("Treasury", None)
    assert names(inside) == ("Finance", None)
    # A visit created now records both names of its department.
    assert admin.patch(f"/departments/{world.a.finance.id}", json={"name_ar": "الخزينة"}).status_code == 200
    later = create_visit(host_api, host.id, TEST_START + timedelta(hours=3))["visit"]
    assert later["department"] == {"id": str(world.a.finance.id), "name": "Treasury", "name_ar": "الخزينة"}


# Two lines: an address keeps its line breaks.
ARABIC_ADDRESS = "مبنى رقم 14" + "\n" + "عمّان"


def test_the_arabic_address_is_a_setting(admin: Api, world: World, db: Session) -> None:
    response = admin.patch(
        "/company/settings",
        json={"address": "Building 14\nAmman", "address_ar": "  " + ARABIC_ADDRESS + "  "},
    )
    assert response.status_code == 200, response.text
    assert (response.json()["address"], response.json()["address_ar"]) == (
        "Building 14\nAmman",
        ARABIC_ADDRESS,
    )
    stored = refreshed(db, Company, world.a.company.id)
    assert stored.address_ar == ARABIC_ADDRESS
    (row,) = audit_rows(db, "COMPANY_SETTINGS_UPDATED", entity_id=world.a.company.id)
    assert row.meta == {"changed_fields": ["address", "address_ar"]}
    # Readable by every role, like the other settings; blank or null clears it.
    assert Api(admin.client).get("/company/settings").json()["address_ar"] == ARABIC_ADDRESS
    assert admin.patch("/company/settings", json={"address_ar": "   "}).json()["address_ar"] is None
    assert admin.patch("/company/settings", json={"address_ar": "عمّان"}).json()["address_ar"] == "عمّان"
    assert admin.patch("/company/settings", json={"address_ar": None}).json()["address_ar"] is None
    assert refreshed(db, Company, world.b.company.id).address_ar is None


@pytest.mark.parametrize("address_ar", ["م" * 1001, "عمّان\x07", 7], ids=["too_long", "control", "not_text"])
def test_the_arabic_address_follows_the_rules_of_the_address(admin: Api, address_ar: object) -> None:
    response = admin.patch("/company/settings", json={"address_ar": address_ar})
    assert response.status_code == 422
    assert set(response.json()["error"]["details"]["fields"]) == {"address_ar"}
    assert admin.patch("/company/settings", json={"address_ar": "م" * 1000}).status_code == 200


def test_only_administrators_set_the_arabic_address(make_client, world: World) -> None:
    for user in (world.a.employee, world.a.receptionist, world.a.manager):
        api = Api(make_client())
        api.login(user.email)
        response = api.patch("/company/settings", json={"address_ar": "عمّان"})
        assert response.status_code == 403 and error_code(response) == "FORBIDDEN"


def test_a_visit_moved_to_another_department_records_both_of_its_names(
    make_client, world: World, factory, db: Session
) -> None:
    """A visit's department snapshots follow a change of department (D-17): both names of the new one,
    and no Arabic name left over from the old one."""
    finance = world.a.finance
    finance.name_ar = "المالية"
    db.commit()
    it = factory.department(world.a.company, "IT", name_ar="تقنية المعلومات")
    legal = factory.department(world.a.company, "Legal")
    host = factory.user(world.a.company, department=finance)
    api = signed_in(make_client, host)
    visit = create_visit(api, host.id, TEST_START + timedelta(hours=2))["visit"]
    assert visit["department"] == {"id": str(finance.id), "name": "Finance", "name_ar": "المالية"}
    for department, expected in (
        (it, {"id": str(it.id), "name": "IT", "name_ar": "تقنية المعلومات"}),
        (legal, {"id": str(legal.id), "name": "Legal", "name_ar": None}),
        (None, None),
    ):
        body = {"department_id": str(department.id) if department else None}
        response = api.patch(f"/visits/{visit['id']}", json=body)
        assert response.status_code == 200, response.text
        assert response.json()["department"] == expected
        stored = refreshed(db, Visit, visit["id"])
        assert (stored.department_name, stored.department_name_ar) == (
            (expected["name"], expected["name_ar"]) if expected else (None, None)
        )


def test_a_concurrent_duplicate_name_with_an_arabic_name_is_still_a_conflict_on_name(
    admin: Api, world: World, db: Session, monkeypatch
) -> None:
    """A rename in both languages whose English name was taken meanwhile: the Arabic name's lookup must
    not flush the rename outside the guarded save, or the duplicate is a 500 instead of a 409."""
    monkeypatch.setattr(DepartmentRepository, "get_by_name", lambda self, company_id, name: None)
    response = admin.patch(f"/departments/{world.a.finance.id}", json={"name": "LEGACY", "name_ar": "الإرث"})
    assert response.status_code == 409, response.text
    assert response.json()["error"]["details"] == {"field": "name"}
    stored = refreshed(db, Department, world.a.finance.id)
    assert (stored.name, stored.name_ar) == ("Finance", None)


# ---- no department shares a name with another, in either language (B10-29) ---------------------------

NAME_TAKEN = "A department with this name already exists."
NAME_AR_TAKEN = "A department with this Arabic name already exists."


def _conflict(response, field: str, message: str) -> None:
    assert response.status_code == 409, response.text
    assert response.json()["error"] == {"code": "CONFLICT", "message": message, "details": {"field": field}}


def test_a_new_name_may_not_be_another_department_s_arabic_name(admin: Api, world: World, factory) -> None:
    """The findings: `{"name": "تقنية المعلومات"}` beside IT / «تقنية المعلومات» (it read the same in Arabic),
    and «العمليات» / "Operations" beside Operations / «العمليات» (each read as the other's name)."""
    factory.department(world.a.company, "IT", name_ar="تقنية المعلومات")
    factory.department(world.a.company, "Operations", name_ar="العمليات")
    _conflict(admin.post("/departments", json={"name": "تقنية المعلومات"}), "name", NAME_AR_TAKEN)
    # With an Arabic name of its own it still shows that name in the English interface: refused too.
    taken = admin.post("/departments", json={"name": "تقنية المعلومات", "name_ar": "الحاسوب"})
    _conflict(taken, "name", NAME_AR_TAKEN)
    swapped = admin.post("/departments", json={"name": "العمليات", "name_ar": "Operations"})
    _conflict(swapped, "name", NAME_AR_TAKEN)
    # Ignoring case, for an Arabic name in Latin letters too.
    factory.department(world.a.company, "Front Desk", name_ar="Mktb")
    _conflict(admin.post("/departments", json={"name": "MKTB"}), "name", NAME_AR_TAKEN)


def test_a_new_arabic_name_may_not_be_another_department_s_name(admin: Api, world: World, factory) -> None:
    """The findings' other half: `{"name": "Cross", "name_ar": "Finance"}` beside Finance, with or without
    an Arabic name of its own."""
    _conflict(admin.post("/departments", json={"name": "Cross", "name_ar": "Finance"}), "name_ar", NAME_TAKEN)
    _conflict(admin.post("/departments", json={"name": "Cross", "name_ar": "fINANCE"}), "name_ar", NAME_TAKEN)
    factory.department(world.a.company, "Security", name_ar="الأمن")
    taken = admin.post("/departments", json={"name": "Procurement", "name_ar": "SECURITY"})
    _conflict(taken, "name_ar", NAME_TAKEN)
    # The same language is reported first: another department's Arabic name.
    _conflict(
        admin.post("/departments", json={"name": "Guards", "name_ar": "الأمن"}), "name_ar", NAME_AR_TAKEN
    )


def test_the_reviewer_s_requests_beside_finance(admin: Api, world: World) -> None:
    """The review's API calls beside Finance / «المالية»."""
    finance = world.a.finance
    assert admin.patch(f"/departments/{finance.id}", json={"name_ar": "المالية"}).status_code == 200
    _conflict(admin.post("/departments", json={"name": "المالية"}), "name", NAME_AR_TAKEN)
    taken = admin.post("/departments", json={"name": "Procurement", "name_ar": "Finance"})
    _conflict(taken, "name_ar", NAME_TAKEN)


def test_inactive_departments_count_and_another_company_s_do_not(admin: Api, world: World, factory) -> None:
    factory.department(world.a.company, "Archive", is_active=False, name_ar="الأرشيف")
    _conflict(admin.post("/departments", json={"name": "الأرشيف"}), "name", NAME_AR_TAKEN)
    # "Legacy" is inactive.
    _conflict(admin.post("/departments", json={"name": "Old", "name_ar": "legacy"}), "name_ar", NAME_TAKEN)
    # Another company's departments do not count, in either direction.
    factory.department(world.b.company, "Logistics", name_ar="اللوجستيات")
    factory.department(world.b.company, "Payroll")
    assert admin.post("/departments", json={"name": "اللوجستيات"}).status_code == 201
    assert admin.post("/departments", json={"name": "Wages", "name_ar": "Payroll"}).status_code == 201


def test_a_rename_may_not_take_another_department_s_name_in_either_language(
    admin: Api, world: World, factory, db: Session
) -> None:
    it = factory.department(world.a.company, "IT", name_ar="تقنية المعلومات")
    legal = factory.department(world.a.company, "Legal")
    renamed = admin.patch(f"/departments/{legal.id}", json={"name": "تقنية المعلومات"})
    _conflict(renamed, "name", NAME_AR_TAKEN)
    _conflict(admin.patch(f"/departments/{legal.id}", json={"name_ar": "FINANCE"}), "name_ar", NAME_TAKEN)
    _conflict(admin.patch(f"/departments/{it.id}", json={"name_ar": "legal"}), "name_ar", NAME_TAKEN)
    both = admin.patch(f"/departments/{legal.id}", json={"name": "Law", "name_ar": "IT"})
    _conflict(both, "name_ar", NAME_TAKEN)
    # Nothing was changed by the refusals, and none was audited.
    stored_legal, stored_it = refreshed(db, Department, legal.id), refreshed(db, Department, it.id)
    assert (stored_legal.name, stored_legal.name_ar) == ("Legal", None)
    assert (stored_it.name, stored_it.name_ar) == ("IT", "تقنية المعلومات")
    assert audit_rows(db, "DEPARTMENT_UPDATED", entity_id=legal.id) == []
    assert audit_rows(db, "DEPARTMENT_UPDATED", entity_id=it.id) == []
    # Clearing an Arabic name never conflicts.
    assert admin.patch(f"/departments/{it.id}", json={"name_ar": None}).status_code == 200


def test_a_department_keeps_its_own_names(admin: Api, world: World, factory) -> None:
    """Its own values are never a conflict: Finance may take "Finance" as its Arabic name, and IT may swap
    its two names."""
    finance = world.a.finance
    assert admin.patch(f"/departments/{finance.id}", json={"name_ar": "Finance"}).status_code == 200
    assert admin.patch(f"/departments/{finance.id}", json={"name_ar": "FINANCE"}).status_code == 200
    assert admin.patch(f"/departments/{finance.id}", json={"name": "finance"}).status_code == 200
    assert admin.post("/departments", json={"name": "Press", "name_ar": "press"}).status_code == 201
    it = factory.department(world.a.company, "IT", name_ar="تقنية المعلومات")
    assert admin.patch(f"/departments/{it.id}", json={"name": "تقنية المعلومات"}).status_code == 200
    swapped = admin.patch(f"/departments/{it.id}", json={"name": "IT", "name_ar": "تقنية المعلومات"})
    assert swapped.status_code == 200
    swapped = admin.patch(f"/departments/{it.id}", json={"name": "تقنية المعلومات", "name_ar": "IT"})
    assert swapped.status_code == 200


def test_departments_that_already_share_a_name_can_still_be_changed(
    admin: Api, world: World, factory, db: Session
) -> None:
    """Data written before B10-29 may hold two departments that share a value across the languages. Their
    other values, their activity and a change of case stay editable; a new shared value is refused."""
    it = factory.department(world.a.company, "IT", name_ar="تقنية المعلومات")
    twin = factory.department(world.a.company, "تقنية المعلومات")
    assert admin.patch(f"/departments/{it.id}", json={"name": "Information Technology"}).status_code == 200
    assert admin.patch(f"/departments/{it.id}", json={"is_active": False}).status_code == 200
    assert admin.patch(f"/departments/{twin.id}", json={"name_ar": "الحاسوب"}).status_code == 200
    factory.department(world.a.company, "Desk", name_ar="Mktb")
    pair = factory.department(world.a.company, "mktb")
    assert admin.patch(f"/departments/{pair.id}", json={"name": "MKTB"}).status_code == 200
    taken = admin.patch(f"/departments/{twin.id}", json={"name_ar": "information technology"})
    _conflict(taken, "name_ar", NAME_TAKEN)
    assert refreshed(db, Department, twin.id).name_ar == "الحاسوب"
