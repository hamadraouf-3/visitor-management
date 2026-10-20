"""A company's e-mail texts, edited by the platform owner (Phase 12, B12-8): the endpoints of
/api/v1/email-templates again under /api/v1/platform/companies/{id}, on the same service. The same texts,
checks, field codes and limits; the change is the company's (its administrators read and change it again)
and is audited in both trails; a test e-mail goes to the platform owner."""

import uuid
from datetime import timedelta

import pytest
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.email.providers.memory import MemoryProvider
from app.models import BrandAssetKind, EmailMessage, EmailTemplateOverride, PlatformAdmin
from tests.conftest import TEST_START
from tests.png_support import SAMPLE_LOGO, drawn_logo
from tests.support import (
    Api,
    Factory,
    PlatformApi,
    World,
    audit_rows,
    create_visit,
    error_code,
    platform_audit_rows,
    platform_signed_in,
    signed_in,
)

KIND = "VISITOR_INVITATION"


@pytest.fixture
def owner(factory: Factory) -> PlatformAdmin:
    return factory.platform_admin(email="owner@platform.test")


@pytest.fixture
def platform(make_client, owner: PlatformAdmin) -> PlatformApi:
    return platform_signed_in(make_client, owner)


@pytest.fixture
def base(world: World) -> str:
    return f"/platform/companies/{world.a.company.id}/email-templates"


def _codes(response) -> dict:
    assert response.status_code == 422, response.text
    return response.json()["error"]["details"]["field_codes"]


def _overrides(response) -> dict:
    assert response.status_code == 200, response.text
    return {field["name"]: field["override"] for field in response.json()["fields"]}


# ---- access ----------------------------------------------------------------------------------------------

REQUESTS = [
    ("GET", "", None),
    ("GET", f"/{KIND}", None),
    ("PATCH", f"/{KIND}", {"en": {"subject": "Hello"}}),
    ("POST", f"/{KIND}/reset", {}),
    ("POST", f"/{KIND}/preview", {"language": "en"}),
    ("GET", f"/{KIND}/preview?language=en", None),
    ("POST", f"/{KIND}/test", {"language": "en"}),
]


@pytest.mark.parametrize(("method", "path", "body"), REQUESTS)
def test_only_the_platform_owner_reaches_them(
    make_client, world: World, base: str, db: Session, method: str, path: str, body: dict | None
) -> None:
    url = "/api/v1" + base + path
    options = {} if body is None else {"json": body}
    response = make_client().request(method, url, **options)
    assert response.status_code == 401 and error_code(response) == "NOT_AUTHENTICATED"
    # The company's own administrator has these under /email-templates, never here.
    admin = signed_in(make_client, world.a.admin)
    response = admin.client.request(method, url, headers={"X-CSRF-Token": admin.csrf_token or ""}, **options)
    assert response.status_code == 401 and error_code(response) == "NOT_AUTHENTICATED"
    assert db.scalar(select(func.count()).select_from(EmailTemplateOverride)) == 0


@pytest.mark.parametrize(("method", "path", "body"), [request for request in REQUESTS if request[0] != "GET"])
def test_a_change_needs_the_platform_csrf_token(
    platform: PlatformApi,
    base: str,
    db: Session,
    email_provider: MemoryProvider,
    method: str,
    path: str,
    body: dict,
) -> None:
    response = platform.client.request(method, "/api/v1" + base + path, json=body)
    assert response.status_code == 403 and error_code(response) == "CSRF_FAILED"
    assert db.scalar(select(func.count()).select_from(EmailTemplateOverride)) == 0
    assert email_provider.sent == []


def test_an_unknown_company_or_kind_is_not_found(platform: PlatformApi, base: str) -> None:
    nowhere = f"/platform/companies/{uuid.uuid4()}/email-templates"
    assert platform.get(nowhere).status_code == 404
    assert platform.get(f"{nowhere}/{KIND}").status_code == 404
    valid = {"en": {"subject": "Hello from {company}"}}
    assert platform.patch(f"{nowhere}/{KIND}", json=valid).status_code == 404
    # What a body may be is checked before anything is looked up, as everywhere in the API.
    assert platform.patch(f"{nowhere}/{KIND}", json={"en": {"subject": "{nope}"}}).status_code == 422
    assert platform.post(f"{nowhere}/{KIND}/reset", json={}).status_code == 404
    assert platform.post(f"{nowhere}/{KIND}/preview", json={"language": "en"}).status_code == 404
    assert platform.get(f"{nowhere}/{KIND}/preview", params={"language": "en"}).status_code == 404
    assert platform.post(f"{nowhere}/{KIND}/test", json={"language": "en"}).status_code == 404
    assert platform.get("/platform/companies/not-an-id/email-templates").status_code == 404
    # The security e-mails are nobody's to reword, here as for the company itself.
    for kind in ("PASSWORD_RESET", "PASSWORD_CHANGED", "PLATFORM_NOTICE", "visitor_invitation", "NOPE"):
        assert platform.get(f"{base}/{kind}").status_code == 404, kind
        assert platform.patch(f"{base}/{kind}", json={"en": {"subject": "x"}}).status_code == 404, kind


# ---- the same texts ----------------------------------------------------------------------------------------


def test_the_platform_owner_reads_what_the_company_s_administrator_reads(
    platform: PlatformApi, make_client, world: World, base: str
) -> None:
    admin = signed_in(make_client, world.a.admin)
    admin.patch(f"/email-templates/{KIND}", json={"en": {"heading": "The administrator's heading"}})
    listed = platform.get(base)
    assert listed.status_code == 200 and listed.json() == admin.get("/email-templates").json()
    assert len(listed.json()) == 7  # the host's three since Phase 14 (B14-2)
    assert platform.get(f"{base}/{KIND}").json() == admin.get(f"/email-templates/{KIND}").json()
    assert _overrides(platform.get(f"{base}/{KIND}"))["heading"]["en"] == "The administrator's heading"
    # Another company's texts are its own.
    other = f"/platform/companies/{world.b.company.id}/email-templates/{KIND}"
    assert _overrides(platform.get(other))["heading"] == {"ar": None, "en": None}


def test_saving_texts_for_a_company(
    platform: PlatformApi, owner: PlatformAdmin, make_client, world: World, base: str, db: Session
) -> None:
    company = world.a.company.id
    response = platform.patch(
        f"{base}/{KIND}",
        json={
            "en": {"subject": "Welcome to {company}", "intro": "  Line one\r\nLine two  "},
            "ar": {"heading": "أهلًا"},
        },
    )
    fields = _overrides(response)
    assert fields["subject"] == {"ar": None, "en": "Welcome to {company}"}
    assert fields["intro"] == {"ar": None, "en": "Line one\nLine two"}
    assert fields["heading"] == {"ar": "أهلًا", "en": None}
    # The texts are the company's: its administrator reads them ...
    admin = signed_in(make_client, world.a.admin)
    assert _overrides(admin.get(f"/email-templates/{KIND}")) == fields
    # ... and no user of the company is named beside them.
    stored = db.scalars(
        select(EmailTemplateOverride).where(EmailTemplateOverride.company_id == company)
    ).all()
    assert {(row.language, row.field) for row in stored} == {
        ("en", "subject"),
        ("en", "intro"),
        ("ar", "heading"),
    }
    assert {row.updated_by_id for row in stored} == {None}

    # Both trails name the fields, never the texts; the company's row says the platform did it, not from
    # where (B11-37).
    [row] = audit_rows(db, "EMAIL_TEMPLATE_UPDATED", company_id=company)
    assert (row.actor_user_id, row.entity_type, row.entity_id) == (None, "email_template", None)
    assert row.meta == {
        "kind": KIND,
        "changed": ["ar.heading", "en.intro", "en.subject"],
        "reset": [],
        "source": "platform",
        "platform_admin_id": str(owner.id),
    }
    assert (row.ip_address, row.user_agent) == (None, None)
    [twin] = platform_audit_rows(db, "EMAIL_TEMPLATE_UPDATED", company_id=company)
    assert twin.actor_platform_admin_id == owner.id and twin.request_id == row.request_id
    assert twin.meta == {"kind": KIND, "changed": ["ar.heading", "en.intro", "en.subject"], "reset": []}
    assert "Welcome" not in str(row.meta) + str(twin.meta)
    # The same texts again change nothing and write no row.
    assert (
        platform.patch(f"{base}/{KIND}", json={"en": {"subject": "Welcome to {company}"}}).status_code == 200
    )
    assert len(audit_rows(db, "EMAIL_TEMPLATE_UPDATED")) == 1

    # The administrator changes one again: now that text names the administrator.
    admin.patch(f"/email-templates/{KIND}", json={"en": {"subject": "Our own subject for {company}"}})
    db.expire_all()
    by_field = {
        (row.language, row.field): row.updated_by_id
        for row in db.scalars(
            select(EmailTemplateOverride).where(EmailTemplateOverride.company_id == company)
        )
    }
    assert by_field[("en", "subject")] == world.a.admin.id and by_field[("en", "intro")] is None
    assert _overrides(platform.get(f"{base}/{KIND}"))["subject"]["en"] == "Our own subject for {company}"
    # Nothing of it reached another company.
    assert (
        db.scalar(
            select(func.count())
            .select_from(EmailTemplateOverride)
            .where(EmailTemplateOverride.company_id == world.b.company.id)
        )
        == 0
    )


def test_the_checks_and_their_field_codes_are_the_company_s_own(
    platform: PlatformApi, base: str, db: Session
) -> None:
    codes = _codes(platform.patch(f"{base}/{KIND}", json={"en": {"intro": "Hello {nobody}"}}))
    assert codes["en.intro"]["code"] == "unknown_placeholder"
    codes = _codes(platform.patch(f"{base}/{KIND}", json={"en": {"subject": "x" * 500}}))
    assert codes["en.subject"]["code"] == "too_long"
    codes = _codes(platform.patch(f"{base}/VISIT_RESCHEDULED", json={"en": {"button": "Open"}}))
    assert codes == {"en.button": {"code": "not_allowed", "params": {}}}
    codes = _codes(platform.patch(f"{base}/{KIND}", json={"en": {"intro": "<b>Welcome</b> {visitor_name}"}}))
    assert codes["en.intro"]["code"] == "markup_not_allowed"
    codes = _codes(platform.patch(f"{base}/{KIND}", json={"fr": {"subject": "Bonjour"}}))
    assert codes["fr"]["code"] == "not_allowed"
    codes = _codes(platform.post(f"{base}/{KIND}/preview", json={"language": "en", "ar": {"intro": "{x}"}}))
    assert codes["ar.intro"]["code"] == "unknown_placeholder"
    codes = _codes(platform.post(f"{base}/{KIND}/preview", json={"language": "fr"}))
    assert codes["language"]["code"] == "invalid_choice"
    assert db.scalar(select(func.count()).select_from(EmailTemplateOverride)) == 0
    assert audit_rows(db, "EMAIL_TEMPLATE_UPDATED") == []


def test_resetting_one_language_or_the_whole_kind(
    platform: PlatformApi, owner: PlatformAdmin, world: World, base: str, db: Session
) -> None:
    platform.patch(
        f"{base}/{KIND}", json={"en": {"subject": "Hello {company}"}, "ar": {"subject": "أهلًا {company}"}}
    )
    one = _overrides(platform.post(f"{base}/{KIND}/reset", json={"language": "en"}))
    assert one["subject"] == {"ar": "أهلًا {company}", "en": None}
    [row] = audit_rows(db, "EMAIL_TEMPLATE_RESET", company_id=world.a.company.id)
    assert row.meta == {
        "kind": KIND,
        "reset": ["en.subject"],
        "source": "platform",
        "platform_admin_id": str(owner.id),
    }
    assert (row.actor_user_id, row.ip_address, row.user_agent) == (None, None, None)
    assert platform_audit_rows(db, "EMAIL_TEMPLATE_RESET")[-1].meta == {"kind": KIND, "reset": ["en.subject"]}
    everything = _overrides(platform.post(f"{base}/{KIND}/reset"))
    assert everything["subject"] == {"ar": None, "en": None}
    assert platform_audit_rows(db, "EMAIL_TEMPLATE_RESET")[-1].meta["reset"] == ["ar.subject"]
    # Nothing left to reset: nothing audited.
    assert platform.post(f"{base}/{KIND}/reset", json={}).status_code == 200
    assert len(audit_rows(db, "EMAIL_TEMPLATE_RESET")) == 2
    assert len(audit_rows(db, "EMAIL_TEMPLATE_UPDATED")) == 1


# ---- preview -----------------------------------------------------------------------------------------------


def test_a_preview_shows_the_company_s_own_e_mail(
    platform: PlatformApi,
    owner: PlatformAdmin,
    world: World,
    base: str,
    db: Session,
    factory: Factory,
    email_provider: MemoryProvider,
) -> None:
    platform.patch(f"{base}/{KIND}", json={"en": {"heading": "Saved heading"}})
    before = db.scalar(select(func.count()).select_from(EmailMessage))
    response = platform.post(
        f"{base}/{KIND}/preview", json={"language": "en", "en": {"intro": "Draft intro for {visitor_name}."}}
    )
    assert response.status_code == 200, response.text
    preview = response.json()
    assert (preview["kind"], preview["language"]) == (KIND, "en")
    assert "Saved heading" in preview["html"] and "Draft intro for Sara Ahmad." in preview["html"]
    assert preview["subject"].startswith("Your visit to Alpha on ")
    # A sample host, never a person of the company and never the platform owner's name.
    assert "Omar Khalil" in preview["text"] and owner.full_name not in preview["text"]
    assert world.a.admin.full_name not in preview["text"]
    assert f"https://vms.test/pass?c={world.a.company.slug}#sample-not-a-visitor-pass" in preview["html"]
    # Without a logo the sample QR code is the only image; with one, the company's logo and colour show.
    assert "cid:" not in preview["html"] and preview["html"].count("data:image/png;base64,") == 1
    factory.brand(world.a.company, color="#7c3aed", images={BrandAssetKind.LOGO: SAMPLE_LOGO})
    branded = platform.post(f"{base}/{KIND}/preview", json={"language": "ar"}).json()
    assert branded["html"].count("data:image/png;base64,") == 2 and "#7C3AED" in branded["html"]
    assert '<html lang="ar" dir="rtl"' in branded["html"] and "عمر خليل" in branded["text"]
    # Nothing saved, sent or queued.
    assert email_provider.sent == []
    assert db.scalar(select(func.count()).select_from(EmailMessage)) == before
    assert _overrides(platform.get(f"{base}/{KIND}"))["intro"] == {"ar": None, "en": None}


def test_a_preview_shows_the_light_design_or_the_dark_one_alone(
    platform: PlatformApi, world: World, base: str, factory: Factory
) -> None:
    """As a company's administrator sees it (B13-5): `scheme` in the body and in the document's query."""
    images = {BrandAssetKind.LOGO: drawn_logo("navy"), BrandAssetKind.LOGO_DARK: drawn_logo("mark")}
    factory.brand(world.a.company, color="#1b3a6b", images=images)
    for scheme, images_shown in (("light", 2), ("dark", 3)):
        html = platform.post(f"{base}/{KIND}/preview", json={"language": "ar", "scheme": scheme}).json()[
            "html"
        ]
        assert f'<meta name="color-scheme" content="{scheme}">' in html and "prefers-color-scheme" not in html
        assert html.count("data:image/png;base64,") == images_shown
        document = platform.get(f"{base}/{KIND}/preview", params={"language": "ar", "scheme": scheme})
        assert f'<meta name="color-scheme" content="{scheme}">' in document.text
    response = platform.post(f"{base}/{KIND}/preview", json={"language": "ar", "scheme": "night"})
    assert response.status_code == 422
    assert platform.get(f"{base}/{KIND}/preview", params={"language": "ar", "scheme": ""}).status_code == 422


def test_the_preview_document_is_sandboxed_like_the_company_s(platform: PlatformApi, base: str) -> None:
    response = platform.get(f"{base}/{KIND}/preview", params={"language": "en"})
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/html")
    policy = response.headers["content-security-policy"]
    assert "sandbox" in policy and "frame-ancestors 'self'" in policy and "script-src" not in policy
    assert "default-src 'none'" in policy
    assert response.headers["x-frame-options"] == "SAMEORIGIN"
    assert response.headers["cache-control"] == "no-store"
    assert "<!DOCTYPE html>" in response.text[:200]
    assert 'src="cid:' not in response.text
    assert platform.get(f"{base}/{KIND}/preview", params={"language": "de"}).status_code == 422
    assert platform.get(f"{base}/{KIND}/preview").status_code == 422  # the language is required
    assert platform.get(f"{base}/{KIND}/preview", params={"language": "en", "x": "1"}).status_code == 422
    # Every other answer of the platform keeps the API's own policy.
    assert (
        platform.get(f"{base}/{KIND}")
        .headers["content-security-policy"]
        .startswith("default-src 'none'; frame-ancestors 'none'")
    )


# ---- test e-mail ---------------------------------------------------------------------------------


def test_a_test_goes_to_the_platform_owner_only_and_is_audited_in_both_trails(
    platform: PlatformApi,
    owner: PlatformAdmin,
    world: World,
    base: str,
    db: Session,
    email_provider: MemoryProvider,
) -> None:
    response = platform.post(
        f"{base}/{KIND}/test", json={"language": "en", "en": {"closing": "Draft closing."}}
    )
    assert response.status_code == 202, response.text
    assert response.json() == {"sent_to": owner.email}
    [email] = email_provider.sent
    assert email.to == owner.email
    assert email.subject.startswith("[Test] Your visit to Alpha")
    assert "Draft closing." in email.html
    assert email.sender == '"Alpha" <no-reply@localhost>'  # as the company's real e-mails (B12-13)
    # The message belongs to the company's e-mails and to no user of it.
    message = db.get(EmailMessage, email.message_id)
    assert message is not None
    assert (message.company_id, message.recipient_user_id, message.visit_id) == (
        world.a.company.id,
        None,
        None,
    )
    [row] = audit_rows(db, "EMAIL_TEMPLATE_TEST_SENT", company_id=world.a.company.id)
    assert row.actor_user_id is None and row.meta["kind"] == KIND and row.meta["draft"] is True
    assert row.meta["source"] == "platform" and row.meta["platform_admin_id"] == str(owner.id)
    assert (row.ip_address, row.user_agent) == (None, None)
    assert owner.email not in str(row.meta)
    [twin] = platform_audit_rows(db, "EMAIL_TEMPLATE_TEST_SENT", company_id=world.a.company.id)
    assert twin.actor_platform_admin_id == owner.id and twin.meta["kind"] == KIND
    # There is no way to name another recipient, and nobody of the company received anything.
    codes = _codes(platform.post(f"{base}/{KIND}/test", json={"language": "en", "to": "x@example.com"}))
    assert codes["to"]["code"] == "not_allowed"
    assert len(email_provider.sent) == 1


def test_a_test_that_leads_with_arabic_says_so_in_arabic(
    platform: PlatformApi, base: str, email_provider: MemoryProvider
) -> None:
    """«[رسالة تجريبية] » when Arabic leads (B12-25), "[Test] " when English does; a preview has neither."""
    assert platform.post(f"{base}/{KIND}/test", json={"language": "ar"}).status_code == 202
    [email] = email_provider.sent
    assert email.subject.startswith("[رسالة تجريبية] زيارتك إلى Alpha يوم ")
    assert " | Your visit to Alpha on " in email.subject and "تجربة]" not in email.subject
    preview = platform.post(f"{base}/{KIND}/preview", json={"language": "ar"}).json()
    assert preview["subject"] == email.subject.removeprefix("[رسالة تجريبية] ")


def test_tests_have_a_budget_per_platform_account_apart_from_the_company_s(
    platform: PlatformApi,
    make_client,
    world: World,
    base: str,
    db: Session,
    email_provider: MemoryProvider,
    factory: Factory,
) -> None:
    other = f"/platform/companies/{world.b.company.id}/email-templates"
    for target in (base, base, base, other, other):  # one budget, whichever company
        assert platform.post(f"{target}/{KIND}/test", json={"language": "ar"}).status_code == 202
    response = platform.post(f"{base}/{KIND}/test", json={"language": "ar"})
    assert response.status_code == 429 and error_code(response) == "RATE_LIMITED"
    assert int(response.headers["retry-after"]) > 0
    assert len(email_provider.sent) == 5
    assert platform_audit_rows(db, "RATE_LIMITED")[-1].meta["policy"] == "template_test_sends_per_user"
    assert audit_rows(db, "RATE_LIMITED") == []
    # The company's administrator still has the whole of their own.
    admin = signed_in(make_client, world.a.admin)
    assert admin.post(f"/email-templates/{KIND}/test", json={"language": "en"}).status_code == 202
    assert email_provider.sent[-1].to == world.a.admin.email
    # ... and so does another platform account: the budget is each account's own.
    second = platform_signed_in(make_client, factory.platform_admin(email="second@platform.test"))
    assert second.post(f"{base}/{KIND}/test", json={"language": "en"}).status_code == 202
    assert email_provider.sent[-1].to == "second@platform.test"
    assert platform.post(f"{base}/{KIND}/test", json={"language": "ar"}).status_code == 429  # still spent


# ---- the texts in use ----------------------------------------------------------------------------


def test_a_real_invitation_uses_the_texts_the_platform_owner_saved(
    platform: PlatformApi, make_client, world: World, base: str, email_provider: MemoryProvider
) -> None:
    saved = platform.patch(
        f"{base}/{KIND}",
        json={"en": {"subject": "See you at {company}", "intro": "Tea & coffee are ready, {visitor_name}."}},
    )
    assert saved.status_code == 200, saved.text
    host: Api = signed_in(make_client, world.a.employee)
    create_visit(host, world.a.employee.id, TEST_START + timedelta(hours=2), send_invitation=True)
    [invitation] = [sent for sent in email_provider.sent if sent.kind == "VISITOR_INVITATION"]
    assert invitation.subject.startswith("See you at Alpha |")
    assert "Tea &amp; coffee are ready, " in invitation.html and "Tea & coffee are ready, " in invitation.text
    # Another company's invitations keep the product's texts.
    other: Api = signed_in(make_client, world.b.employee)
    create_visit(other, world.b.employee.id, TEST_START + timedelta(hours=2), send_invitation=True)
    assert email_provider.sent[-3].kind == "VISITOR_INVITATION"
    assert email_provider.sent[-3].subject.startswith("Your visit to Bravo on ")


def test_the_texts_of_a_deactivated_company_can_still_be_prepared(
    platform: PlatformApi, world: World, base: str
) -> None:
    assert platform.post(f"/platform/companies/{world.a.company.id}/deactivate").status_code == 200
    assert platform.get(base).status_code == 200
    saved = _overrides(platform.patch(f"{base}/{KIND}", json={"en": {"heading": "Welcome back"}}))
    assert saved["heading"]["en"] == "Welcome back"
