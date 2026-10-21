"""The platform owner's management of companies (Phase 11, B11-2, B11-5, B11-9 to B11-13): listing with
counts only, creating a company with its first administrator, changing its identity, deactivating and
reactivating it (sign-in, sessions, reset links and passes), its administrators and their reset links,
and the audit rows in both trails."""

import re
import uuid
from datetime import timedelta

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.errors import NotAuthenticated, PassInvalid, PasswordChangeRequired
from app.core.request_context import SYSTEM_CONTEXT
from app.core.time import FakeClock
from app.email.logos import light_rendition
from app.email.providers.memory import MemoryProvider
from app.models import (
    BrandAssetKind,
    Company,
    EmailMessage,
    PlatformAdmin,
    PlatformSession,
    Role,
    User,
    UserSession,
)
from app.repositories.brand import CompanyBrandRepository
from app.security.platform_sessions import PlatformAuthContext
from app.services.authorization import require_platform_still_authorized
from app.services.passes import PassService
from tests.png_support import SAMPLE_LOGO
from tests.support import (
    DEFAULT_PASSWORD,
    Api,
    Factory,
    PlatformApi,
    World,
    audit_rows,
    create_visit,
    error_code,
    no_brand,
    pass_token,
    platform_audit_rows,
    platform_signed_in,
    rate_limits,
    refreshed,
    signed_in,
)

TEMP_PASSWORD = "Tmp-Kiwi-Lantern-2026"


@pytest.fixture
def owner(factory: Factory) -> PlatformAdmin:
    return factory.platform_admin(email="owner@platform.test")


@pytest.fixture
def platform(make_client, owner: PlatformAdmin) -> PlatformApi:
    return platform_signed_in(make_client, owner)


def _company_body(**overrides) -> dict:
    body = {
        "name": "  Nova Labs ",
        "name_ar": "نوفا لابز",
        "slug": "nova-labs",
        "timezone": "Asia/Amman",
        "default_language": "en",
        "admin": {
            "full_name": "Nadia Admin",
            "email": "Nadia@Nova.Example",
            "temporary_password": TEMP_PASSWORD,
        },
    }
    body.update(overrides)
    return body


# ---- listing ---------------------------------------------------------------------------------------------


def test_the_list_shows_companies_with_their_counts_only(
    owner: PlatformAdmin, world: World, make_client, factory: Factory, clock: FakeClock
) -> None:
    factory.user(world.a.company, is_active=False)
    admin = signed_in(make_client, world.a.admin)
    create_visit(admin, world.a.admin.id, clock.now() + timedelta(minutes=30))
    create_visit(admin, world.a.admin.id, clock.now() + timedelta(days=3))  # not yet: not counted
    clock.advance(timedelta(hours=2))  # the first visit's start is now in the past 30 days
    platform = platform_signed_in(make_client, owner)
    response = platform.get("/platform/companies", params={"q": "alpha"})
    assert response.status_code == 200
    page = response.json()
    assert page["total"] == 1 and page["page"] == 1
    [alpha] = page["items"]
    assert alpha == {
        "id": str(world.a.company.id),
        "name": "Alpha",
        "name_ar": None,
        "slug": world.a.company.slug,
        "timezone": "Asia/Amman",
        "default_language": "en",
        "is_active": True,
        "deactivated_at": None,
        "created_at": alpha["created_at"],
        "updated_at": alpha["updated_at"],
        "counts": {"active_users": 4, "visits_last_30_days": 1},
        "brand": no_brand(),  # its identity (B12-7): nothing set yet
        "tracking_allowed": False,  # the Visitor Journey (Phase 15, B15-2): off until allowed
    }


def test_the_list_filters_and_pages(platform: PlatformApi, world: World) -> None:
    platform.post(f"/platform/companies/{world.b.company.id}/deactivate")
    inactive = platform.get("/platform/companies", params={"is_active": "false"}).json()
    assert str(world.b.company.id) in {item["id"] for item in inactive["items"]}
    assert str(world.a.company.id) not in {item["id"] for item in inactive["items"]}
    first = platform.get("/platform/companies", params={"page_size": 1}).json()
    assert len(first["items"]) == 1 and first["total"] >= 2
    response = platform.get("/platform/companies", params={"sort": "name"})
    assert response.status_code == 422


def test_a_company_and_its_administrators(platform: PlatformApi, world: World, factory: Factory) -> None:
    factory.user(world.a.company, roles=(Role.SYSTEM_ADMIN, Role.EMPLOYEE), full_name="Second Admin")
    response = platform.get(f"/platform/companies/{world.a.company.id}")
    assert response.status_code == 200 and response.json()["name"] == "Alpha"
    admins = platform.get(f"/platform/companies/{world.a.company.id}/admins").json()
    # Only administrators: never the company's other users.
    assert {admin["full_name"] for admin in admins} == {"Alpha Admin", "Second Admin"}
    assert set(admins[0]) == {
        "id",
        "full_name",
        "email",
        "is_active",
        "must_change_password",
        "last_login_at",
        "created_at",
    }
    assert platform.get(f"/platform/companies/{uuid.uuid4()}").status_code == 404
    assert platform.get(f"/platform/companies/{uuid.uuid4()}/admins").status_code == 404
    assert platform.get("/platform/companies/not-an-id").status_code == 404


# ---- creating ----------------------------------------------------------------------------------------------


def test_creating_a_company_with_its_first_administrator(
    platform: PlatformApi, owner: PlatformAdmin, db: Session, make_client, clock: FakeClock
) -> None:
    response = platform.post("/platform/companies", json=_company_body())
    assert response.status_code == 201, response.text
    created = response.json()
    company = created["company"]
    assert (company["name"], company["name_ar"], company["slug"]) == ("Nova Labs", "نوفا لابز", "nova-labs")
    assert company["counts"] == {"active_users": 1, "visits_last_30_days": 0}
    admin = created["admin"]
    assert (admin["email"], admin["must_change_password"], admin["is_active"]) == (
        "nadia@nova.example",
        True,
        True,
    )
    company_id = uuid.UUID(company["id"])
    user = refreshed(db, User, uuid.UUID(admin["id"]))
    assert user.roles == ["SYSTEM_ADMIN"] and user.must_change_password
    assert user.password_expires_at is not None and user.password_expires_at > clock.now() + timedelta(
        hours=71
    )
    assert platform_audit_rows(db, "USER_CREATED", company_id=company_id)[0].entity_id == user.id
    # The new administrator signs in with the temporary password and must change it.
    api = Api(make_client())
    assert api.login("nadia@nova.example", TEMP_PASSWORD).status_code == 200
    response = api.get("/users")
    assert response.status_code == 403 and error_code(response) == "PASSWORD_CHANGE_REQUIRED"


@pytest.mark.parametrize(
    ("overrides", "path", "code"),
    [
        ({"slug": "Nova Labs"}, "slug", "invalid_format"),
        ({"slug": "-nova"}, "slug", "invalid_format"),
        ({"timezone": "Mars/Olympus"}, "timezone", "invalid_timezone"),
        ({"default_language": "fr"}, "default_language", "invalid_choice"),
        ({"name": ""}, "name", "required"),
        (
            {"admin": {"full_name": "Nadia", "email": "nadia@nova.example", "temporary_password": "short"}},
            "admin.temporary_password",
            "too_short",
        ),
        (
            {"admin": {"full_name": "Nadia", "email": "not-an-address", "temporary_password": TEMP_PASSWORD}},
            "admin.email",
            "invalid_email",
        ),
    ],
)
def test_a_new_company_is_checked(platform: PlatformApi, overrides: dict, path: str, code: str) -> None:
    response = platform.post("/platform/companies", json=_company_body(**overrides))
    assert response.status_code == 422, response.text
    assert response.json()["error"]["details"]["field_codes"][path]["code"] == code


def test_a_taken_slug_or_address_is_refused(platform: PlatformApi, world: World, db: Session) -> None:
    response = platform.post("/platform/companies", json=_company_body(slug=world.a.company.slug))
    assert response.status_code == 409 and error_code(response) == "CONFLICT"
    assert response.json()["error"]["details"] == {"field": "slug"}
    body = _company_body(
        admin={"full_name": "X", "email": world.b.admin.email, "temporary_password": TEMP_PASSWORD}
    )
    response = platform.post("/platform/companies", json=body)
    assert response.status_code == 409 and error_code(response) == "USER_EMAIL_UNAVAILABLE"
    assert db.scalars(select(Company).where(Company.slug == "nova-labs")).one_or_none() is None


# ---- identity -------------------------------------------------------------------------------------------


def test_changing_a_company_s_identity(
    platform: PlatformApi, owner: PlatformAdmin, world: World, db: Session
) -> None:
    response = platform.patch(
        f"/platform/companies/{world.a.company.id}",
        json={
            "name": "Alpha Group",
            "name_ar": "مجموعة ألفا",
            "default_language": "ar",
            "timezone": "Asia/Amman",
        },
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert (body["name"], body["name_ar"], body["default_language"]) == ("Alpha Group", "مجموعة ألفا", "ar")
    [row] = audit_rows(db, "COMPANY_SETTINGS_UPDATED", company_id=world.a.company.id)
    assert row.actor_user_id is None
    assert row.meta == {
        "changed_fields": ["name", "name_ar", "default_language"],
        "source": "platform",
        "platform_admin_id": str(owner.id),
    }
    assert platform_audit_rows(db, "COMPANY_SETTINGS_UPDATED")[0].meta == {
        "changed_fields": ["name", "name_ar", "default_language"]
    }
    # Clearing the Arabic name; the slug never changes.
    assert (
        platform.patch(f"/platform/companies/{world.a.company.id}", json={"name_ar": None}).json()["name_ar"]
        is None
    )
    response = platform.patch(f"/platform/companies/{world.a.company.id}", json={"slug": "other"})
    assert response.json()["error"]["details"]["field_codes"]["slug"]["code"] == "not_allowed"
    response = platform.patch(f"/platform/companies/{world.a.company.id}", json={"name": None})
    assert response.json()["error"]["details"]["field_codes"]["name"]["code"] == "required"
    response = platform.patch(f"/platform/companies/{world.a.company.id}", json={"timezone": "Nowhere/Land"})
    assert response.json()["error"]["details"]["field_codes"]["timezone"]["code"] == "invalid_timezone"


def test_a_platform_change_counts_as_a_person_s_for_the_seeds(
    platform: PlatformApi, world: World, db: Session
) -> None:
    from app.repositories.audit_logs import AuditLogRepository

    platform.patch(f"/platform/companies/{world.a.company.id}", json={"name": "Renamed"})
    chosen = AuditLogRepository(db).fields_changed_by_people(
        world.a.company.id, "COMPANY_SETTINGS_UPDATED", world.a.company.id
    )
    assert chosen == {"name"}


# ---- deactivation ----------------------------------------------------------------------------------------


def test_deactivating_a_company_ends_its_users_access(
    platform: PlatformApi,
    owner: PlatformAdmin,
    world: World,
    make_client,
    db: Session,
    clock: FakeClock,
    email_provider: MemoryProvider,
    settings,
) -> None:
    signed = signed_in(make_client, world.a.employee)
    visit = create_visit(
        signed_in(make_client, world.a.admin), world.a.admin.id, clock.now() + timedelta(minutes=30)
    )
    token = pass_token(visit["pass_url"])
    # A reset link issued before the deactivation.
    Api(make_client()).post("/auth/forgot-password", json={"email": world.a.employee.email}, csrf=False)
    reset_url = email_provider.sent[-1].reset_url or ""
    reset_token = re.search(r"#token=([A-Za-z0-9_-]+)", reset_url).group(1)  # type: ignore[union-attr]

    response = platform.post(f"/platform/companies/{world.a.company.id}/deactivate")
    assert response.status_code == 200
    body = response.json()
    assert body["is_active"] is False and body["deactivated_at"] is not None

    # Its sessions are revoked, its sign-in refused, its reset links dead.
    assert signed.get("/auth/me").status_code == 401
    live = db.scalars(
        select(UserSession).where(
            UserSession.company_id == world.a.company.id, UserSession.revoked_at.is_(None)
        )
    ).all()
    assert live == []
    # The right password is told why (B11-46, `test_company_inactive_sign_in.py`); a wrong one is not.
    response = Api(make_client()).login(world.a.admin.email)
    assert response.status_code == 409 and error_code(response) == "COMPANY_INACTIVE"
    assert audit_rows(db, "AUTH_LOGIN_FAILED", actor_user_id=world.a.admin.id)[-1].meta == {
        "reason": "company_inactive"
    }
    response = Api(make_client()).login(world.a.admin.email, "Wrong-Password-1234")
    assert response.status_code == 401 and error_code(response) == "INVALID_CREDENTIALS"
    response = Api(make_client()).post(
        "/auth/reset-password",
        json={"token": reset_token, "new_password": "Brand-New-Passphrase-77"},
        csrf=False,
    )
    assert response.status_code == 400 and error_code(response) == "INVALID_RESET_TOKEN"
    sent = len(email_provider.sent)
    Api(make_client()).post("/auth/forgot-password", json={"email": world.a.employee.email}, csrf=False)
    assert len(email_provider.sent) == sent  # nothing for a deactivated company
    # Its passes are refused like unknown ones.
    with pytest.raises(PassInvalid):
        PassService(db, settings=settings).presented(world.a.company.id, token)
    # The other company is untouched.
    assert signed_in(make_client, world.b.employee).get("/auth/me").status_code == 200
    # Audited in both trails.
    [row] = audit_rows(db, "COMPANY_DEACTIVATED", company_id=world.a.company.id)
    assert row.actor_user_id is None and row.meta["source"] == "platform"
    assert row.meta["revoked_sessions"] >= 2 and row.meta["invalidated_reset_links"] == 1
    assert platform_audit_rows(db, "COMPANY_DEACTIVATED")[0].actor_platform_admin_id == owner.id


def test_reactivating_a_company_restores_sign_in(
    platform: PlatformApi, world: World, make_client, db: Session
) -> None:
    assert platform.post(f"/platform/companies/{world.a.company.id}/deactivate").status_code == 200
    # Doing it again changes and audits nothing.
    assert platform.post(f"/platform/companies/{world.a.company.id}/deactivate").status_code == 200
    assert len(audit_rows(db, "COMPANY_DEACTIVATED")) == 1
    response = platform.post(f"/platform/companies/{world.a.company.id}/reactivate")
    assert response.status_code == 200 and response.json()["is_active"] is True
    assert response.json()["deactivated_at"] is None
    assert Api(make_client()).login(world.a.admin.email).status_code == 200
    assert len(audit_rows(db, "COMPANY_REACTIVATED", company_id=world.a.company.id)) == 1
    assert platform.post(f"/platform/companies/{uuid.uuid4()}/reactivate").status_code == 404


def test_a_deactivated_company_s_pass_is_found_again_after_reactivation(
    platform: PlatformApi, world: World, make_client, db: Session, clock: FakeClock, settings
) -> None:
    visit = create_visit(
        signed_in(make_client, world.a.admin), world.a.admin.id, clock.now() + timedelta(minutes=30)
    )
    token = pass_token(visit["pass_url"])
    platform.post(f"/platform/companies/{world.a.company.id}/deactivate")
    platform.post(f"/platform/companies/{world.a.company.id}/reactivate")
    reception = signed_in(make_client, world.a.receptionist)
    response = reception.post("/reception/scan", json={"token": token})
    assert response.status_code == 200 and response.json()["result"] == "READY"


# ---- administrators ---------------------------------------------------------------------------------------


def test_adding_an_administrator(
    platform: PlatformApi, owner: PlatformAdmin, world: World, db: Session, make_client
) -> None:
    response = platform.post(
        f"/platform/companies/{world.a.company.id}/admins",
        json={
            "full_name": "Extra Admin",
            "email": "extra@alpha.example",
            "temporary_password": TEMP_PASSWORD,
        },
    )
    assert response.status_code == 201, response.text
    created = response.json()
    assert created["must_change_password"] is True
    user = refreshed(db, User, uuid.UUID(created["id"]))
    assert user.company_id == world.a.company.id and user.roles == ["SYSTEM_ADMIN"]
    assert audit_rows(db, "USER_CREATED", company_id=world.a.company.id)[0].meta["platform_admin_id"] == str(
        owner.id
    )
    assert Api(make_client()).login("extra@alpha.example", TEMP_PASSWORD).status_code == 200
    response = platform.post(
        f"/platform/companies/{world.a.company.id}/admins",
        json={"full_name": "Dup", "email": world.b.employee.email, "temporary_password": TEMP_PASSWORD},
    )
    assert response.status_code == 409 and error_code(response) == "USER_EMAIL_UNAVAILABLE"
    response = platform.post(
        f"/platform/companies/{world.a.company.id}/admins",
        json={"full_name": "Weak", "email": "weak@alpha.example", "temporary_password": "Password1234"},
    )
    assert response.json()["error"]["details"]["field_codes"]["temporary_password"]["code"].startswith(
        "password_"
    )
    response = platform.post(
        f"/platform/companies/{uuid.uuid4()}/admins",
        json={"full_name": "X", "email": "x@alpha.example", "temporary_password": TEMP_PASSWORD},
    )
    assert response.status_code == 404


def test_refusals_for_taken_addresses_are_audited_and_budgeted(
    platform: PlatformApi, owner: PlatformAdmin, world: World, db: Session, app
) -> None:
    """B11-42: "this address cannot be used" says the address has an account in some company. The platform
    owner's refusals are on record and bounded like an administrator's (SEC-05)."""
    admins = f"/platform/companies/{world.a.company.id}/admins"
    taken = {"full_name": "Dup", "email": world.b.employee.email, "temporary_password": TEMP_PASSWORD}
    free = {"full_name": "Free", "email": "free@alpha.example", "temporary_password": TEMP_PASSWORD}
    company_with_taken = _company_body(
        admin={"full_name": "X", "email": world.a.employee.email, "temporary_password": TEMP_PASSWORD}
    )
    with rate_limits(app, user_email_refusals_per_user=3):
        # A creation that succeeds spends nothing.
        assert platform.post(admins, json=free).status_code == 201
        for _ in range(2):
            response = platform.post(admins, json=taken)
            assert response.status_code == 409 and error_code(response) == "USER_EMAIL_UNAVAILABLE"
        response = platform.post("/platform/companies", json=company_with_taken)  # the same budget
        assert response.status_code == 409 and error_code(response) == "USER_EMAIL_UNAVAILABLE"
        # Spent: every creation is refused before the address is looked up, a free one as well, so the
        # answer says nothing about any address.
        for path, body in (
            (admins, taken),
            (admins, {**free, "email": "free2@alpha.example"}),
            ("/platform/companies", _company_body()),
        ):
            response = platform.post(path, json=body)
            assert response.status_code == 429 and error_code(response) == "RATE_LIMITED", response.text
            assert int(response.headers["retry-after"]) > 0
    rows = platform_audit_rows(db, "USER_CHANGE_REFUSED", actor_platform_admin_id=owner.id)
    assert [row.meta for row in rows] == [{"code": "USER_EMAIL_UNAVAILABLE", "operation": "create"}] * 3
    assert [row.company_id for row in rows] == [world.a.company.id, world.a.company.id, None]
    assert all(row.entity_id is None for row in rows)  # never which account, never the address
    assert platform_audit_rows(db, "RATE_LIMITED")[-1].meta["policy"] == "user_email_refusals_per_user"
    # A company's trail and its administrators' own budgets are untouched.
    assert audit_rows(db, "USER_CHANGE_REFUSED") == []
    assert db.scalars(select(Company).where(Company.slug == "nova-labs")).one_or_none() is None
    assert db.scalars(select(User).where(User.email == "free2@alpha.example")).one_or_none() is None


def test_sending_an_administrator_a_reset_link(
    platform: PlatformApi,
    owner: PlatformAdmin,
    world: World,
    db: Session,
    email_provider: MemoryProvider,
    make_client,
) -> None:
    response = platform.post(
        f"/platform/companies/{world.a.company.id}/admins/{world.a.admin.id}/password-reset"
    )
    assert response.status_code == 202, response.text
    assert response.json() == {"sent_to": world.a.admin.email}
    [email] = email_provider.sent
    assert email.to == world.a.admin.email and email.kind == "PASSWORD_RESET"
    token = re.search(r"#token=([A-Za-z0-9_-]+)", email.reset_url or "").group(1)  # type: ignore[union-attr]
    [row] = audit_rows(db, "AUTH_PASSWORD_RESET_REQUESTED", company_id=world.a.company.id)
    assert row.actor_user_id is None and row.meta["source"] == "platform"
    assert platform_audit_rows(db, "AUTH_PASSWORD_RESET_REQUESTED")[0].entity_id == world.a.admin.id
    # The administrator completes it as any reset.
    response = Api(make_client()).post(
        "/auth/reset-password", json={"token": token, "new_password": "Fresh-Meadow-Lantern-58"}, csrf=False
    )
    assert response.status_code == 204


# ---- the company's other administrators are told (B11-43) ---------------------------------------------


@pytest.fixture
def colleagues(world: World, factory: Factory) -> dict[str, User]:
    """Alpha's administrators besides its first one: an English reader, an Arabic reader, one who also
    holds another role, and one who is deactivated."""
    company = world.a.company
    return {
        "english": factory.user(company, roles=(Role.SYSTEM_ADMIN,), full_name="Lina Saleh"),
        "arabic": factory.user(
            company, roles=(Role.SYSTEM_ADMIN,), full_name="هند ناصر", preferred_language="ar"
        ),
        "two_roles": factory.user(company, roles=(Role.EMPLOYEE, Role.SYSTEM_ADMIN), full_name="Rami Odeh"),
        "inactive": factory.user(company, roles=(Role.SYSTEM_ADMIN,), is_active=False),
    }


def _notices(email_provider: MemoryProvider) -> list:
    return [email for email in email_provider.sent if email.kind == "PLATFORM_ACTION_NOTICE"]


def test_adding_an_administrator_tells_the_company_s_other_administrators(
    platform: PlatformApi,
    owner: PlatformAdmin,
    world: World,
    colleagues: dict[str, User],
    db: Session,
    email_provider: MemoryProvider,
    make_client,
) -> None:
    """The finding: the platform owner can read a company by adding itself an administrator, and the only
    trace was an audit row that nobody is told to read."""
    platform.client.headers["User-Agent"] = "OwnerLaptop/7.1"
    response = platform.post(
        f"/platform/companies/{world.a.company.id}/admins",
        json={
            "full_name": "Support Access",
            "email": "support@platform.example",
            "temporary_password": TEMP_PASSWORD,
        },
    )
    assert response.status_code == 201, response.text
    assert set(response.json()) == {  # the answer itself is what it was
        "id",
        "full_name",
        "email",
        "is_active",
        "must_change_password",
        "last_login_at",
        "created_at",
    }
    notices = _notices(email_provider)
    told = {
        world.a.admin.email,
        colleagues["english"].email,
        colleagues["arabic"].email,
        colleagues["two_roles"].email,
    }
    # Every other active administrator, and nobody else: not the new one, not a deactivated one, not the
    # company's other users, not another company.
    assert {email.to for email in notices} == told and len(notices) == 4
    assert len(email_provider.sent) == 4
    by_recipient = {email.to: email for email in notices}
    english, arabic = by_recipient[colleagues["english"].email], by_recipient[colleagues["arabic"].email]
    assert english.subject == "A new administrator was added to Alpha"
    assert arabic.subject == "أُضيف مدير نظام جديد إلى Alpha"  # the recipient's own language leads
    assert '<html lang="en" dir="ltr"' in english.html and '<html lang="ar" dir="rtl"' in arabic.html
    for email in notices:
        assert "The platform owner added a new administrator account to Alpha on " in email.text
        assert "Support Access" in email.text and "support@platform.example" in email.text
        # Who: "the platform owner". Never its name, its address, its ID or where it works from; never a
        # credential.
        for part in (email.html, email.text, email.subject):
            for secret in (
                owner.full_name,
                owner.email,
                str(owner.id),
                "203.0.113.10",
                "OwnerLaptop",
                TEMP_PASSWORD,
            ):
                assert secret not in part
        assert email.reset_url is None and email.pass_url is None
        # The company's own e-mail (B12-22): sent in its name from the configured address, signed by
        # it, and nothing of the product in it. Alpha has no logo: no image at all.
        assert email.sender == '"Alpha" <no-reply@localhost>'
        assert email.inline_images == ()
        assert "Sent by Alpha." in email.text and "أُرسلت من" in email.text
        for part in (email.html, email.text, email.subject, email.sender):
            for word in ("Mawdoo3", "موضوع", "Visitors", "زوار", "on behalf of", "نيابةً عن"):
                assert word not in part, word
    # Both trails say how many were told; the e-mail log names each recipient.
    created = uuid.UUID(response.json()["id"])
    [row] = audit_rows(db, "USER_CREATED", entity_id=created)
    assert row.meta == {
        "roles": ["SYSTEM_ADMIN"],
        "notified_admins": 4,
        "source": "platform",
        "platform_admin_id": str(owner.id),
    }
    [twin] = platform_audit_rows(db, "USER_CREATED", entity_id=created)
    assert twin.meta == {"roles": ["SYSTEM_ADMIN"], "notified_admins": 4}
    logged = db.scalars(select(EmailMessage).where(EmailMessage.kind == "PLATFORM_ACTION_NOTICE")).all()
    assert {message.recipient_user_id for message in logged} == {
        world.a.admin.id,
        colleagues["english"].id,
        colleagues["arabic"].id,
        colleagues["two_roles"].id,
    }
    assert {message.company_id for message in logged} == {world.a.company.id}
    assert all(message.status == "SENT" and message.visit_id is None for message in logged)


def test_a_reset_link_tells_the_other_administrators_and_reads_as_the_platform_owner_s(
    platform: PlatformApi,
    owner: PlatformAdmin,
    world: World,
    colleagues: dict[str, User],
    db: Session,
    email_provider: MemoryProvider,
) -> None:
    target = colleagues["english"]
    response = platform.post(f"/platform/companies/{world.a.company.id}/admins/{target.id}/password-reset")
    assert response.status_code == 202 and response.json() == {"sent_to": target.email}
    [reset] = [email for email in email_provider.sent if email.kind == "PASSWORD_RESET"]
    assert reset.to == target.email and reset.reset_url is not None
    # B11-49: nobody "requested" this link.
    assert "The platform owner sent you a link to set a new password for your Alpha account." in reset.text
    assert "We received a request" not in reset.text and "did not request" not in reset.text
    assert "This link expires in 30 minutes and can be used once." in reset.text
    notices = _notices(email_provider)
    assert {email.to for email in notices} == {
        world.a.admin.email,
        colleagues["arabic"].email,
        colleagues["two_roles"].email,
    }  # not the one who got the link
    for email in notices:
        assert "The platform owner sent a password-reset link to an administrator of Alpha on " in email.text
        assert "Lina Saleh" in email.text and target.email in email.text
        # The link itself goes to its recipient only.
        assert (
            "#token=" not in email.html and "#token=" not in email.text and "reset-password" not in email.html
        )
    arabic = next(email for email in notices if email.to == colleagues["arabic"].email)
    assert arabic.subject == "أُرسل رابط لإعادة تعيين كلمة المرور إلى أحد مديري النظام في Alpha"
    [row] = audit_rows(db, "AUTH_PASSWORD_RESET_REQUESTED", entity_id=target.id)
    assert row.meta["notified_admins"] == 3 and row.meta["source"] == "platform"
    assert platform_audit_rows(db, "AUTH_PASSWORD_RESET_REQUESTED")[0].meta["notified_admins"] == 3


def test_the_notices_carry_the_company_s_own_logo_and_colour(
    platform: PlatformApi,
    world: World,
    colleagues: dict[str, User],
    factory: Factory,
    email_provider: MemoryProvider,
) -> None:
    """B12-22: what the platform owner did is told in the company's identity, its logo and its own
    colour (a yellow company's bar is yellow, B12-21), as every other e-mail of the company is."""
    company = world.a.company
    factory.brand(company, color="#f5b800", images={BrandAssetKind.LOGO: SAMPLE_LOGO})
    stored = CompanyBrandRepository(factory.db).image(company.id, BrandAssetKind.LOGO)
    assert stored is not None
    added = platform.post(
        f"/platform/companies/{company.id}/admins",
        json={
            "full_name": "Support Access",
            "email": "support@platform.example",
            "temporary_password": TEMP_PASSWORD,
        },
    )
    assert added.status_code == 201, added.text
    target = colleagues["english"]
    reset = platform.post(f"/platform/companies/{company.id}/admins/{target.id}/password-reset")
    assert reset.status_code == 202, reset.text
    notices = _notices(email_provider)
    assert len(notices) == 4 + 4  # the four other administrators, twice (the new one is told of the reset)
    for email in notices:
        assert [(image.content_id, image.content) for image in email.inline_images] == [
            ("brand-logo", light_rendition(stored.content).content)  # its rendition (B13-2)
        ]
        assert 'src="cid:brand-logo"' in email.html and 'alt="Alpha"' in email.html
        assert '<td height="6" bgcolor="#F5B800"' in email.html  # the bar: the company's own colour
        assert "#188086" not in email.html and "#27B5BB" not in email.html  # none of the product's teal
        assert email.sender == '"Alpha" <no-reply@localhost>'
        assert "Mawdoo3" not in email.html + email.text + email.subject
    # The reset link itself is the company's e-mail too, with its yellow button and dark text.
    [link] = [email for email in email_provider.sent if email.kind == "PASSWORD_RESET"]
    assert re.search(
        r'bgcolor="#F5B800" class="vbn" style="border-radius:10px;background-color:#F5B800;'
        r'border:2px solid #8E6900;[^"]*">\s*<a [^>]*color:#1C262B;',
        link.html,
    )


def test_a_forgot_password_request_keeps_its_own_words(
    world: World, make_client, email_provider: MemoryProvider
) -> None:
    Api(make_client()).post("/auth/forgot-password", json={"email": world.a.admin.email}, csrf=False)
    [reset] = email_provider.sent
    assert "We received a request to reset the password for your Alpha account." in reset.text
    assert "If you did not request this, ignore this email." in reset.text
    assert "platform owner" not in reset.text and _notices(email_provider) == []


def test_nobody_is_told_where_there_is_nobody_else(
    platform: PlatformApi, world: World, db: Session, email_provider: MemoryProvider
) -> None:
    # A new company: its first administrator is the only one.
    created = platform.post("/platform/companies", json=_company_body()).json()
    assert email_provider.sent == []
    [row] = audit_rows(db, "USER_CREATED", entity_id=uuid.UUID(created["admin"]["id"]))
    assert "notified_admins" not in row.meta
    # A reset link for a company's only administrator.
    response = platform.post(
        f"/platform/companies/{world.b.company.id}/admins/{world.b.admin.id}/password-reset"
    )
    assert response.status_code == 202
    assert [email.kind for email in email_provider.sent] == ["PASSWORD_RESET"]
    [row] = audit_rows(db, "AUTH_PASSWORD_RESET_REQUESTED", company_id=world.b.company.id)
    assert row.meta["notified_admins"] == 0


def test_a_refused_action_tells_nobody(
    platform: PlatformApi, world: World, colleagues: dict[str, User], email_provider: MemoryProvider
) -> None:
    admins = f"/platform/companies/{world.a.company.id}/admins"
    taken = {"full_name": "Dup", "email": world.b.employee.email, "temporary_password": TEMP_PASSWORD}
    assert platform.post(admins, json=taken).status_code == 409
    assert platform.post(admins, json={**taken, "temporary_password": "short"}).status_code == 422
    assert platform.post(f"{admins}/{colleagues['inactive'].id}/password-reset").status_code == 409
    assert platform.post(f"{admins}/{world.a.employee.id}/password-reset").status_code == 404
    assert platform.post(admins, json=taken, csrf=False).status_code == 403
    assert email_provider.sent == []


def test_notices_have_a_budget_per_recipient(
    platform: PlatformApi,
    owner: PlatformAdmin,
    world: World,
    db: Session,
    email_provider: MemoryProvider,
    clock: FakeClock,
) -> None:
    """Five an hour for each administrator: whoever holds a platform account cannot flood a mailbox with
    them. The action is still done and audited; the audit rows say how many were told."""
    admins = f"/platform/companies/{world.a.company.id}/admins"
    for number in range(7):
        body = {"full_name": f"Extra {number}", "email": f"extra{number}@alpha.example"}
        assert platform.post(admins, json={**body, "temporary_password": TEMP_PASSWORD}).status_code == 201
    to_the_first = [email for email in _notices(email_provider) if email.to == world.a.admin.email]
    assert len(to_the_first) == 5
    rows = audit_rows(db, "USER_CREATED", company_id=world.a.company.id)
    # The first administrator is told five times; each new one is told about those after it, up to five.
    assert [row.meta["notified_admins"] for row in rows] == [1, 2, 3, 4, 5, 5, 5]
    clock.advance(hours=1, seconds=1)
    assert platform.login(owner.email).status_code == 200  # the platform session idled out meanwhile
    body = {"full_name": "Later", "email": "later@alpha.example", "temporary_password": TEMP_PASSWORD}
    assert platform.post(admins, json=body).status_code == 201
    assert len([email for email in _notices(email_provider) if email.to == world.a.admin.email]) == 6
    # The notices do not touch the budget of "password changed" notices, or the reverse.
    assert audit_rows(db, "RATE_LIMITED") == [] and platform_audit_rows(db, "RATE_LIMITED") == []


def test_the_notice_cannot_be_edited_by_the_company(make_client, world: World) -> None:
    admin = signed_in(make_client, world.a.admin)
    assert admin.get("/email-templates/PLATFORM_ACTION_NOTICE").status_code == 404
    response = admin.patch(
        "/email-templates/PLATFORM_ACTION_NOTICE", json={"en": {"heading": "Nothing happened"}}
    )
    assert response.status_code == 404
    assert "PLATFORM_ACTION_NOTICE" not in {item["kind"] for item in admin.get("/email-templates").json()}


def test_a_reset_link_is_only_for_an_active_administrator_of_an_active_company(
    platform: PlatformApi, world: World, factory: Factory
) -> None:
    base = f"/platform/companies/{world.a.company.id}/admins"
    response = platform.post(f"{base}/{world.a.employee.id}/password-reset")  # not an administrator
    assert response.status_code == 404
    response = platform.post(
        f"/platform/companies/{world.b.company.id}/admins/{world.a.admin.id}/password-reset"
    )
    assert response.status_code == 404  # another company's administrator
    inactive = factory.user(world.a.company, roles=(Role.SYSTEM_ADMIN,), is_active=False)
    response = platform.post(f"{base}/{inactive.id}/password-reset")
    assert response.status_code == 409 and error_code(response) == "ACCOUNT_INACTIVE"
    platform.post(f"/platform/companies/{world.a.company.id}/deactivate")
    response = platform.post(f"{base}/{world.a.admin.id}/password-reset")
    assert response.status_code == 409 and error_code(response) == "COMPANY_INACTIVE"


def test_reset_links_share_the_account_s_budget(platform: PlatformApi, world: World, db: Session) -> None:
    path = f"/platform/companies/{world.a.company.id}/admins/{world.a.admin.id}/password-reset"
    for _ in range(3):
        assert platform.post(path).status_code == 202
    response = platform.post(path)
    assert response.status_code == 429 and error_code(response) == "RATE_LIMITED"
    assert platform_audit_rows(db, "RATE_LIMITED")[-1].meta["policy"] == "forgot_password_account"


# ---- the platform's trail -------------------------------------------------------------------------------


def test_the_platform_audit_trail(platform: PlatformApi, owner: PlatformAdmin, world: World) -> None:
    platform.post(f"/platform/companies/{world.a.company.id}/deactivate")
    platform.post(f"/platform/companies/{world.b.company.id}/deactivate")
    page = platform.get("/platform/audit-logs", params={"company_id": str(world.a.company.id)}).json()
    assert page["total"] == 1
    [row] = page["items"]
    assert row["action"] == "COMPANY_DEACTIVATED"
    assert row["actor"] == {"id": str(owner.id), "full_name": "Platform Owner"}
    assert row["company"] == {"id": str(world.a.company.id), "name": "Alpha", "name_ar": None}
    assert row["ip_address"] == "203.0.113.10"
    actions = [item["action"] for item in platform.get("/platform/audit-logs").json()["items"]]
    assert actions[:3] == ["COMPANY_DEACTIVATED", "COMPANY_DEACTIVATED", "AUTH_LOGIN_SUCCEEDED"]
    login = platform.get("/platform/audit-logs", params={"action": "AUTH_LOGIN_SUCCEEDED"}).json()
    assert login["items"][0]["company"] is None
    assert platform.get("/platform/audit-logs", params={"action": "not valid"}).status_code == 422


def test_a_company_never_learns_where_the_platform_owner_works_from(
    owner: PlatformAdmin, world: World, db: Session, make_client
) -> None:
    """B11-37: the rows a platform action leaves in a company's own trail say what was done and by which
    platform account, not from which network address or browser; the platform's trail keeps both."""
    platform = PlatformApi(make_client(headers={"User-Agent": "OwnerLaptop/7.1"}))
    assert platform.login(owner.email).status_code == 200
    company = world.a.company.id
    created = platform.post("/platform/companies", json=_company_body()).json()
    assert platform.patch(f"/platform/companies/{company}", json={"name": "Alpha Two"}).status_code == 200
    added = platform.post(
        f"/platform/companies/{company}/admins",
        json={
            "full_name": "Extra Admin",
            "email": "extra@alpha.example",
            "temporary_password": TEMP_PASSWORD,
        },
    )
    assert added.status_code == 201, added.text
    reset = platform.post(f"/platform/companies/{company}/admins/{world.a.admin.id}/password-reset")
    assert reset.status_code == 202, reset.text
    assert platform.post(f"/platform/companies/{world.b.company.id}/deactivate").status_code == 200
    assert platform.post(f"/platform/companies/{world.b.company.id}/reactivate").status_code == 200

    expected = {
        (uuid.UUID(created["company"]["id"]), "COMPANY_CREATED"),
        (uuid.UUID(created["company"]["id"]), "USER_CREATED"),
        (company, "COMPANY_SETTINGS_UPDATED"),
        (company, "USER_CREATED"),
        (company, "AUTH_PASSWORD_RESET_REQUESTED"),
        (world.b.company.id, "COMPANY_DEACTIVATED"),
        (world.b.company.id, "COMPANY_REACTIVATED"),
    }
    for company_id, action in expected:
        [row] = audit_rows(db, action, company_id=company_id)
        assert row.meta["source"] == "platform", action
        assert (row.ip_address, row.user_agent) == (None, None), action
        assert row.request_id is not None, action  # the two rows of one action still share its request
        [twin] = platform_audit_rows(db, action, company_id=company_id)
        assert (str(twin.ip_address), twin.user_agent) == ("203.0.113.10", "OwnerLaptop/7.1"), action
        assert twin.request_id == row.request_id, action
    # What the company's administrator reads in the audit page.
    tenant = signed_in(make_client, world.b.admin)
    listed = tenant.get("/audit-logs", params={"action": "COMPANY_REACTIVATED"}).json()["items"]
    assert [(item["ip_address"], item["user_agent"]) for item in listed] == [(None, None)]
    assert listed[0]["request_id"] is not None and listed[0]["actor"] is None


def test_what_a_platform_write_re_checks_once_it_holds_its_locks(
    platform: PlatformApi, owner: PlatformAdmin, db: Session, clock: FakeClock
) -> None:
    """B11-38, the checks themselves (the waiting is in `test_credential_races.py`): the session still
    live, the account still active and not under a forced password change."""
    session = db.scalars(select(PlatformSession).where(PlatformSession.platform_admin_id == owner.id)).one()
    auth = PlatformAuthContext.build(owner, session)

    def check() -> None:
        require_platform_still_authorized(db, auth, now=clock.now())

    check()  # live, active, no forced change
    owner.must_change_password = True  # what `create-platform-admin --reset` sets
    db.commit()
    with pytest.raises(PasswordChangeRequired):
        check()
    owner.must_change_password = False
    owner.is_active = False
    db.commit()
    with pytest.raises(NotAuthenticated) as ended:
        check()
    [event] = ended.value.security_events
    assert (event.action, event.metadata) == ("ACCESS_DENIED", {"reason": "session_ended"})
    owner.is_active = True
    db.commit()
    check()
    assert platform.post("/platform/auth/logout").status_code == 204
    with pytest.raises(NotAuthenticated):
        check()


def test_a_platform_write_re_checks_the_session_s_absolute_lifetime(
    platform: PlatformApi, owner: PlatformAdmin, db: Session, clock: FakeClock
) -> None:
    session = db.scalars(select(PlatformSession).where(PlatformSession.platform_admin_id == owner.id)).one()
    auth = PlatformAuthContext.build(owner, session)
    require_platform_still_authorized(db, auth, now=clock.now())
    clock.advance(hours=8, seconds=1)  # PLATFORM_SESSION_MAX_AGE_HOURS
    with pytest.raises(NotAuthenticated):
        require_platform_still_authorized(db, auth, now=clock.now())


def test_a_platform_request_writes_nothing_without_the_csrf_token(
    platform: PlatformApi, world: World, db: Session
) -> None:
    response = platform.post(f"/platform/companies/{world.a.company.id}/deactivate", csrf=False)
    assert response.status_code == 403
    assert refreshed(db, Company, world.a.company.id).is_active is True


def test_the_system_context_is_not_a_platform_admin() -> None:
    assert SYSTEM_CONTEXT.request_id is None  # CLI rows have no actor and no request
    assert DEFAULT_PASSWORD
