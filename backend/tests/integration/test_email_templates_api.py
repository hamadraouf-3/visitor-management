"""A company's own e-mail texts through the API (Phase 11, B11-20 to B11-31): who may use it, the checks
and their field codes, saving and resetting, the audit rows, the preview, the test e-mail (to oneself
only, within its budget), the texts used when a real e-mail is sent, and isolation between companies."""

from datetime import timedelta

import pytest
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.time import FakeClock
from app.email.providers.memory import MemoryProvider
from app.models import BrandAssetKind, EmailMessage, EmailTemplateOverride, Role
from tests.png_support import drawn_logo
from tests.support import Api, Factory, World, audit_rows, check_in, create_visit, error_code, signed_in

BASE = "/email-templates"
INVITATION = f"{BASE}/VISITOR_INVITATION"


@pytest.fixture
def admin(make_client, world: World) -> Api:
    return signed_in(make_client, world.a.admin)


def _patch(api: Api, kind: str = "VISITOR_INVITATION", **languages):
    return api.patch(f"{BASE}/{kind}", json=languages)


def _codes(response) -> dict:
    assert response.status_code == 422, response.text
    return response.json()["error"]["details"]["field_codes"]


# ---- access ------------------------------------------------------------------------------------------


@pytest.mark.parametrize("role", [Role.EMPLOYEE, Role.RECEPTIONIST, Role.MANAGEMENT])
def test_only_administrators_may_use_it(make_client, world: World, role: Role, db: Session) -> None:
    api = signed_in(make_client, world.a.users_by_role[role])
    body = {"language": "en"}
    for response in (
        api.get(BASE),
        api.get(INVITATION),
        api.patch(INVITATION, json={"en": {"heading": "Hi"}}),
        api.post(f"{INVITATION}/reset", json={}),
        api.post(f"{INVITATION}/preview", json=body),
        api.get(f"{INVITATION}/preview", params={"language": "en"}),
        api.post(f"{INVITATION}/test", json=body),
    ):
        assert response.status_code == 403, response.text
        assert error_code(response) == "FORBIDDEN"
    assert len(audit_rows(db, "ACCESS_DENIED", actor_user_id=world.a.users_by_role[role].id)) == 7


def test_anonymous_callers_are_refused(client) -> None:
    api = Api(client)
    assert api.get(BASE).status_code == 401
    assert api.patch(INVITATION, json={}).status_code == 401


def test_a_change_needs_the_csrf_token(admin: Api, db: Session, world: World) -> None:
    response = admin.patch(INVITATION, json={"en": {"heading": "Hi"}}, csrf=False)
    assert response.status_code == 403 and error_code(response) == "CSRF_FAILED"
    assert audit_rows(db, "CSRF_FAILED", actor_user_id=world.a.admin.id)


# ---- reading ---------------------------------------------------------------------------------------------


def test_the_list_names_every_editable_kind_with_its_fields_defaults_and_variables(admin: Api) -> None:
    response = admin.get(BASE)
    assert response.status_code == 200
    kinds = {item["kind"]: item for item in response.json()}
    assert list(kinds) == [
        "VISITOR_INVITATION",
        "VISIT_RESCHEDULED",
        "VISIT_CANCELLED",
        "HOST_ARRIVAL",
        # The host's e-mails of a scheduled visit (Phase 14, B14-2).
        "HOST_VISIT_SCHEDULED",
        "HOST_VISIT_RESCHEDULED",
        "HOST_VISIT_CANCELLED",
    ]
    invitation = kinds["VISITOR_INVITATION"]
    assert invitation["updated_at"] is None
    assert "visitor_name" in invitation["variables"]
    assert {item["max_variable_uses"] for item in kinds.values()} == {3}  # B11-40
    fields = {field["name"]: field for field in invitation["fields"]}
    assert list(fields) == ["subject", "heading", "greeting", "intro", "button", "closing", "footer_note"]
    assert fields["subject"] == {
        "name": "subject",
        "multiline": False,
        "max_length": 150,
        "required_variables": ["company"],
        "forbidden_variables": ["purpose"],  # B11-40: free text of one visit is not for a subject
        "default": {"ar": "زيارتك إلى {company} يوم {date}", "en": "Your visit to {company} on {date}"},
        "override": {"ar": None, "en": None},
    }
    assert fields["closing"]["default"] == {"ar": "", "en": ""}
    for kind in kinds.values():
        forbidden = {field["name"]: field["forbidden_variables"] for field in kind["fields"]}
        assert forbidden.pop("subject") == ["purpose"] and set(map(tuple, forbidden.values())) == {()}
    assert "button" not in {field["name"] for field in kinds["VISIT_RESCHEDULED"]["fields"]}
    # The host's three: the host arrival's fields, the visit's own variables, the visitor named in the
    # subject (B14-2).
    for kind in ("HOST_VISIT_SCHEDULED", "HOST_VISIT_RESCHEDULED", "HOST_VISIT_CANCELLED"):
        spec = kinds[kind]
        assert spec["variables"] == [
            "host_name",
            "visitor_name",
            "visitor_company",
            "company",
            "date",
            "time",
            "timezone",
            "department",
            "purpose",
        ]
        host_fields = {field["name"]: field for field in spec["fields"]}
        assert list(host_fields) == ["subject", "heading", "greeting", "intro", "closing", "footer_note"]
        assert host_fields["subject"]["required_variables"] == ["visitor_name"]
        assert host_fields["greeting"]["default"] == {"ar": "مرحبًا {host_name}،", "en": "Hello {host_name},"}
    defaults = {kind: {f["name"]: f["default"]["en"] for f in kinds[kind]["fields"]} for kind in kinds}
    assert defaults["HOST_VISIT_SCHEDULED"]["subject"] == "New visit: {visitor_name} on {date}"
    assert defaults["HOST_VISIT_SCHEDULED"]["intro"] == (
        "You have a visit from {visitor_name} on {date}, {time} ({timezone})."
    )
    assert defaults["HOST_VISIT_RESCHEDULED"]["subject"] == "Visit rescheduled: {visitor_name} on {date}"
    assert defaults["HOST_VISIT_CANCELLED"]["subject"] == "Visit cancelled: {visitor_name} on {date}"


@pytest.mark.parametrize("kind", ["PASSWORD_RESET", "PASSWORD_CHANGED", "visitor_invitation", "NOPE"])
def test_the_security_e_mails_and_unknown_kinds_are_not_found(admin: Api, kind: str) -> None:
    response = admin.get(f"{BASE}/{kind}")
    assert response.status_code == 404 and error_code(response) == "NOT_FOUND"
    assert admin.patch(f"{BASE}/{kind}", json={"en": {"subject": "x"}}).status_code == 404


# ---- saving, checking, resetting -------------------------------------------------------------------------


def test_saving_texts_and_the_audit_row_names_fields_not_texts(
    admin: Api, db: Session, world: World, clock: FakeClock
) -> None:
    response = _patch(
        admin,
        en={"subject": "Welcome to {company}", "intro": "  Line one\r\nLine two  "},
        ar={"heading": "أهلًا بك في {company}"},
    )
    assert response.status_code == 200, response.text
    fields = {field["name"]: field["override"] for field in response.json()["fields"]}
    assert fields["subject"] == {"ar": None, "en": "Welcome to {company}"}
    assert fields["intro"] == {"ar": None, "en": "Line one\nLine two"}  # CRLF normalised, trimmed
    assert fields["heading"] == {"ar": "أهلًا بك في {company}", "en": None}
    assert response.json()["updated_at"] is not None
    [row] = audit_rows(db, "EMAIL_TEMPLATE_UPDATED", company_id=world.a.company.id)
    assert row.actor_user_id == world.a.admin.id and row.entity_type == "email_template"
    assert row.meta == {
        "kind": "VISITOR_INVITATION",
        "changed": ["ar.heading", "en.intro", "en.subject"],  # sorted
        "reset": [],
    }
    assert "Welcome" not in str(row.meta)
    # The same texts again change nothing and write no row.
    assert _patch(admin, en={"subject": "Welcome to {company}"}).status_code == 200
    assert len(audit_rows(db, "EMAIL_TEMPLATE_UPDATED")) == 1
    stored = db.scalars(
        select(EmailTemplateOverride).where(EmailTemplateOverride.company_id == world.a.company.id)
    ).all()
    assert {(row.language, row.field) for row in stored} == {
        ("en", "subject"),
        ("en", "intro"),
        ("ar", "heading"),
    }
    assert {row.updated_by_id for row in stored} == {world.a.admin.id}


def test_an_empty_or_null_text_returns_to_the_product_s(admin: Api, db: Session) -> None:
    _patch(admin, en={"subject": "Welcome to {company}", "heading": "Hello"})
    response = _patch(admin, en={"subject": "   ", "heading": None})
    fields = {field["name"]: field["override"] for field in response.json()["fields"]}
    assert fields["subject"] == fields["heading"] == {"ar": None, "en": None}
    last = audit_rows(db, "EMAIL_TEMPLATE_UPDATED")[-1]
    assert last.meta["reset"] == ["en.heading", "en.subject"] and last.meta["changed"] == []


@pytest.mark.parametrize(
    ("body", "path", "code", "params"),
    [
        ({"en": {"intro": "Hi {visitor}"}}, "en.intro", "unknown_placeholder", "name"),
        ({"ar": {"subject": "زيارتك يوم {date}"}}, "ar.subject", "placeholder_required", {"name": "company"}),
        ({"en": {"intro": "a } b"}}, "en.intro", "invalid_placeholder", {}),
        ({"en": {"intro": "<a href='x'>click</a>"}}, "en.intro", "markup_not_allowed", {}),
        ({"en": {"subject": "Visit {company}\nBcc: x@y.z"}}, "en.subject", "line_breaks", {}),
        ({"en": {"heading": "x" * 151}}, "en.heading", "too_long", {"max": 150}),
        ({"en": {"intro": "bell\u0007"}}, "en.intro", "control_characters", {}),
        ({"en": {"intro": "x\N{RIGHT-TO-LEFT OVERRIDE}y"}}, "en.intro", "bidi_controls", {}),
        ({"en": {"recipient": "x"}}, "en.recipient", "not_allowed", {}),
        # B11-40: what bounds the size of an e-mail.
        (
            {"en": {"subject": "{company}: {purpose}"}},
            "en.subject",
            "placeholder_not_allowed",
            {"name": "purpose"},
        ),
        (
            {"ar": {"intro": "{purpose} {purpose} {purpose} {purpose}"}},
            "ar.intro",
            "placeholder_repeated",
            {"name": "purpose", "max": 3},
        ),
        (
            {"en": {"subject": "{company}" + "{purpose}" * 15}},
            "en.subject",
            "placeholder_not_allowed",
            {"name": "purpose"},
        ),
    ],
)
def test_each_problem_is_a_field_error_with_its_code(admin: Api, body, path, code, params) -> None:
    codes = _codes(_patch(admin, **body))
    assert codes[path]["code"] == code
    if isinstance(params, dict):
        assert codes[path]["params"] == params
    else:
        assert codes[path]["params"]["name"] == "visitor"
        assert "visitor_name" in codes[path]["params"]["allowed"]


def test_a_field_the_kind_does_not_have_is_not_allowed(admin: Api) -> None:
    codes = _codes(_patch(admin, "VISIT_RESCHEDULED", en={"button": "Open"}))
    assert codes == {"en.button": {"code": "not_allowed", "params": {}}}


def test_nothing_is_saved_when_any_text_is_refused(admin: Api, db: Session, world: World) -> None:
    _codes(_patch(admin, en={"heading": "Fine", "intro": "Bad {nope}"}))
    count = db.scalar(
        select(func.count())
        .select_from(EmailTemplateOverride)
        .where(EmailTemplateOverride.company_id == world.a.company.id)
    )
    assert count == 0


def test_resetting_one_language_or_the_whole_kind(admin: Api, db: Session) -> None:
    _patch(admin, en={"heading": "Hello"}, ar={"heading": "مرحبًا"})
    response = admin.post(f"{INVITATION}/reset", json={"language": "ar"})
    assert response.status_code == 200
    heading = next(field for field in response.json()["fields"] if field["name"] == "heading")
    assert heading["override"] == {"ar": None, "en": "Hello"}
    assert audit_rows(db, "EMAIL_TEMPLATE_RESET")[-1].meta == {
        "kind": "VISITOR_INVITATION",
        "reset": ["ar.heading"],
    }
    response = admin.post(f"{INVITATION}/reset")  # no body: both languages
    heading = next(field for field in response.json()["fields"] if field["name"] == "heading")
    assert heading["override"] == {"ar": None, "en": None}
    assert len(audit_rows(db, "EMAIL_TEMPLATE_RESET")) == 2
    admin.post(f"{INVITATION}/reset", json={})  # nothing left to reset: no row
    assert len(audit_rows(db, "EMAIL_TEMPLATE_RESET")) == 2


# ---- the texts in real e-mails ---------------------------------------------------------------------------


def test_a_sent_invitation_uses_the_company_s_texts_escaped(
    admin: Api, world: World, clock: FakeClock, email_provider: MemoryProvider
) -> None:
    _patch(
        admin,
        en={
            "subject": "Your pass for {company}",
            "intro": "{host_name} looks forward to meeting you about {purpose}.",
            "closing": "Free parking at gate 2.",
        },
    )
    create_visit(
        admin,
        world.a.admin.id,
        clock.now() + timedelta(hours=2),
        visitor={"full_name": "Eve <img src=x>", "email": "eve@example.com"},
        purpose="Budget <script>",
        send_invitation=True,
    )
    email, calendar, _host_notice = email_provider.sent
    assert email.subject.startswith("Your pass for Alpha |")
    # The calendar invitation that follows it takes the company's subject too (B14-10), and none of the
    # invitation's body.
    assert calendar.kind == "VISITOR_CALENDAR" and calendar.subject == email.subject
    assert "Free parking at gate 2." not in calendar.html and "Eve &lt;img src=x&gt;" not in calendar.html
    assert "looks forward to meeting you about Budget &lt;script&gt;." in email.html
    assert "Free parking at gate 2." in email.html and "Free parking at gate 2." in email.text
    assert "<script>" not in email.html and "<img src=x>" not in email.html
    assert "Eve &lt;img src=x&gt;" in email.html


def test_a_text_saved_before_a_rule_is_not_sent_or_previewed(
    admin: Api, world: World, db: Session, clock: FakeClock, email_provider: MemoryProvider
) -> None:
    """B11-40: the reviewer's texts, as a database from before the rules holds them. What the rules bound
    is bounded for every e-mail, whatever is stored: the fields fall back to the product's texts."""
    assert _patch(admin, en={"heading": "A heading that passes"}).status_code == 200
    stored = {"subject": "{company}" + "{purpose}" * 15, "intro": "{purpose}" * 111}
    for field, text in stored.items():
        db.add(
            EmailTemplateOverride(
                company_id=world.a.company.id,
                kind="VISITOR_INVITATION",
                language="en",
                field=field,
                text=text,
            )
        )
    db.commit()
    create_visit(
        admin,
        world.a.admin.id,
        clock.now() + timedelta(hours=2),
        visitor={"full_name": "Eve", "email": "eve@example.com"},
        purpose="P" * 500,
        send_invitation=True,
    )
    email, calendar, _host_notice = email_provider.sent
    assert calendar.subject == email.subject  # the stored subject is not used there either
    assert email.subject.startswith("Your visit to Alpha on ") and len(email.subject) < 200
    assert "A heading that passes" in email.html  # the text that passes is used
    assert "has invited you to visit Alpha." in email.text  # the product's intro
    assert len(email.html) < 40_000 and email.text.count("P" * 500) == 2  # the details, once a language
    message = db.get(EmailMessage, email.message_id)
    assert message is not None and message.subject == email.subject
    preview = admin.post(f"{INVITATION}/preview", json={"language": "en"}).json()
    assert preview["subject"].startswith("Your visit to Alpha on ") and len(preview["html"]) < 60_000
    # The editor still shows what is stored, so the administrator can correct it.
    fields = {field["name"]: field["override"]["en"] for field in admin.get(INVITATION).json()["fields"]}
    assert fields["subject"] == stored["subject"] and fields["intro"] == stored["intro"]
    # ... and saving it again is refused, as any new text with it would be.
    assert _codes(_patch(admin, en={"intro": stored["intro"]}))["en.intro"]["code"] == "placeholder_repeated"


def test_each_company_s_texts_are_its_own(
    admin: Api, make_client, world: World, clock: FakeClock, email_provider: MemoryProvider
) -> None:
    _patch(admin, en={"heading": "Alpha's own heading"})
    other = signed_in(make_client, world.b.admin)
    kinds = {item["kind"]: item for item in other.get(BASE).json()}
    heading = next(f for f in kinds["VISITOR_INVITATION"]["fields"] if f["name"] == "heading")
    assert heading["override"] == {"ar": None, "en": None}
    create_visit(
        other,
        world.b.admin.id,
        clock.now() + timedelta(hours=2),
        visitor={"full_name": "Bob", "email": "bob@example.com"},
        send_invitation=True,
    )
    email, calendar, _host_notice = email_provider.sent
    assert "Alpha's own heading" not in calendar.html and "Your visit to Bravo" in calendar.html
    assert "Alpha's own heading" not in email.html
    assert "Your visit to Bravo" in email.html


def test_a_host_arrival_uses_the_company_s_texts(
    make_client, admin: Api, world: World, clock: FakeClock, email_provider: MemoryProvider
) -> None:
    _patch(admin, "HOST_ARRIVAL", en={"subject": "{visitor_name} is at the desk"})
    visit = create_visit(admin, world.a.employee.id, clock.now() + timedelta(minutes=10))["visit"]
    reception = signed_in(make_client, world.a.receptionist)
    assert check_in(reception, visit["id"]).status_code == 200
    [email] = [sent for sent in email_provider.sent if sent.kind == "HOST_ARRIVAL"]
    assert email.to == world.a.employee.email and email.subject == "Dana Guest is at the desk"


# ---- preview -------------------------------------------------------------------------------------------


def test_a_preview_renders_sample_data_with_a_draft_and_sends_nothing(
    admin: Api, db: Session, world: World, email_provider: MemoryProvider
) -> None:
    _patch(admin, en={"heading": "Saved heading"})
    before = db.scalar(select(func.count()).select_from(EmailMessage))
    response = admin.post(
        f"{INVITATION}/preview", json={"language": "en", "en": {"intro": "Draft intro for {visitor_name}."}}
    )
    assert response.status_code == 200, response.text
    preview = response.json()
    assert (preview["kind"], preview["language"]) == ("VISITOR_INVITATION", "en")
    assert "Saved heading" in preview["html"]
    assert "Draft intro for Sara Ahmad." in preview["html"]
    assert "Draft intro for Sara Ahmad." in preview["text"]
    assert preview["subject"].startswith("Your visit to Alpha on ")
    # The sample QR code is the document's only image: the company has no logo (B12-12).
    assert "cid:" not in preview["html"] and preview["html"].count("data:image/png;base64,") == 1
    # The address a real invitation of this company carries, with a fragment that is no pass (B12-14).
    assert f"https://vms.test/pass?c={world.a.company.slug}#sample-not-a-visitor-pass" in preview["html"]
    assert world.a.admin.full_name in preview["text"]  # the caller is the sample host
    # Nothing saved, sent or queued.
    assert email_provider.sent == []
    assert db.scalar(select(func.count()).select_from(EmailMessage)) == before
    heading = next(f for f in admin.get(INVITATION).json()["fields"] if f["name"] == "intro")
    assert heading["override"] == {"ar": None, "en": None}


def test_a_preview_shows_a_text_that_names_an_inline_image_as_it_was_typed(admin: Api) -> None:
    """The preview turned every "cid:visitor-pass-qr" of the HTML into the image's data, the words of a
    company's text included (5 KiB of base64 per mention). Only the images' own `src` are images."""
    plain = admin.post(f"{INVITATION}/preview", json={"language": "en"}).json()["html"]
    intro = "Show cid:visitor-pass-qr, not cid:brand-logo, at the desk."
    closing = 'It is not src="cid:visitor-pass-qr" either.'
    response = admin.post(
        f"{INVITATION}/preview", json={"language": "en", "en": {"intro": intro, "closing": closing}}
    )
    assert response.status_code == 200, response.text
    html = response.json()["html"]
    assert intro in html
    assert "It is not src=&#34;cid:visitor-pass-qr&#34; either." in html  # escaped, so not an attribute
    assert html.count("data:image/png;base64,") == plain.count("data:image/png;base64,") == 1
    assert 'src="cid:' not in html  # every image of the document is inline data
    assert len(html) < len(plain) + 1000  # the texts' own length, and no image data
    document = admin.get(f"{INVITATION}/preview", params={"language": "en"})
    assert 'src="cid:' not in document.text and document.text.count("data:image/png;base64,") == 1


def test_a_preview_leads_with_the_language_asked_for(admin: Api) -> None:
    arabic = admin.post(f"{BASE}/HOST_ARRIVAL/preview", json={"language": "ar"}).json()
    assert arabic["subject"] == "زائرك سارة أحمد في الاستقبال"
    assert '<html lang="ar" dir="rtl"' in arabic["html"]


def test_a_draft_is_checked_like_a_change(admin: Api) -> None:
    codes = _codes(admin.post(f"{INVITATION}/preview", json={"language": "en", "ar": {"intro": "{x}"}}))
    assert codes["ar.intro"]["code"] == "unknown_placeholder"
    codes = _codes(admin.post(f"{INVITATION}/preview", json={"language": "fr"}))
    assert codes["language"]["code"] == "invalid_choice"


def test_the_preview_document_is_sandboxed_and_frameable_only_by_the_application(admin: Api) -> None:
    response = admin.get(f"{INVITATION}/preview", params={"language": "en"})
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/html")
    policy = response.headers["content-security-policy"]
    assert "sandbox" in policy and "frame-ancestors 'self'" in policy and "script-src" not in policy
    assert "default-src 'none'" in policy
    assert response.headers["x-frame-options"] == "SAMEORIGIN"
    assert response.headers["cache-control"] == "no-store"
    assert response.text.startswith("<!DOCTYPE html>") or "<!DOCTYPE html>" in response.text[:200]
    # Every other API response keeps the API's own policy.
    assert (
        admin.get(INVITATION)
        .headers["content-security-policy"]
        .startswith("default-src 'none'; frame-ancestors 'none'")
    )
    assert admin.get(f"{INVITATION}/preview", params={"language": "de"}).status_code == 422


# ---- one design at a time (Phase 13, B13-5) --------------------------------------------------------------


def _bank(factory: Factory, world: World) -> None:
    """The owner's case: a navy wordmark for light surfaces and its diamond alone for dark ones."""
    images = {BrandAssetKind.LOGO: drawn_logo("navy"), BrandAssetKind.LOGO_DARK: drawn_logo("mark")}
    factory.brand(world.a.company, color="#1b3a6b", images=images)


def test_a_preview_shows_the_light_design_or_the_dark_one_alone(
    admin: Api, factory: Factory, world: World
) -> None:
    """A document in a frame follows the device's scheme whatever the page around it says: each preview
    is one design, as a client in that scheme shows it. Light is the default."""
    _bank(factory, world)
    light = admin.post(f"{INVITATION}/preview", json={"language": "en", "scheme": "light"}).json()["html"]
    assert admin.post(f"{INVITATION}/preview", json={"language": "en"}).json()["html"] == light
    dark = admin.post(f"{INVITATION}/preview", json={"language": "en", "scheme": "dark"}).json()["html"]
    assert '<meta name="color-scheme" content="light">' in light and "prefers-color-scheme" not in light
    assert light.count("data:image/png;base64,") == 2  # the QR code and the light rendition
    assert '<meta name="color-scheme" content="dark">' in dark and "prefers-color-scheme" not in dark
    assert ".vdo{display:block!important;" in dark
    assert dark.count("data:image/png;base64,") == 3  # and the dark rendition
    for scheme, meta in (("light", "light"), ("dark", "dark"), (None, "light")):
        params = {"language": "en"} | ({"scheme": scheme} if scheme else {})
        document = admin.get(f"{INVITATION}/preview", params=params)
        assert document.status_code == 200
        assert f'<meta name="color-scheme" content="{meta}">' in document.text


def test_a_scheme_is_light_or_dark(admin: Api) -> None:
    codes = _codes(admin.post(f"{INVITATION}/preview", json={"language": "en", "scheme": "sepia"}))
    assert codes["scheme"]["code"] == "invalid_choice"
    response = admin.get(f"{INVITATION}/preview", params={"language": "en", "scheme": "auto"})
    assert response.status_code == 422


def test_a_test_e_mail_carries_both_designs_whatever_the_preview_showed(
    admin: Api, factory: Factory, world: World, email_provider: MemoryProvider
) -> None:
    """The test e-mail is the e-mail as it is sent: `scheme` does not apply to it."""
    _bank(factory, world)
    assert admin.post(f"{INVITATION}/test", json={"language": "en", "scheme": "dark"}).status_code == 202
    [email] = email_provider.sent
    assert '<meta name="color-scheme" content="light dark">' in email.html
    assert "@media (prefers-color-scheme: dark)" in email.html
    assert {image.content_id for image in email.inline_images} == {
        "visitor-pass-qr",
        "brand-logo",
        "brand-logo-dark",
    }


# ---- test e-mail ---------------------------------------------------------------------------------------


def test_a_test_goes_to_the_caller_only_and_is_audited(
    admin: Api, db: Session, world: World, email_provider: MemoryProvider
) -> None:
    response = admin.post(f"{INVITATION}/test", json={"language": "en", "en": {"closing": "Draft closing."}})
    assert response.status_code == 202, response.text
    assert response.json() == {"sent_to": world.a.admin.email}
    [email] = email_provider.sent
    assert email.to == world.a.admin.email
    assert email.subject.startswith("[Test] Your visit to Alpha")
    assert "Draft closing." in email.html
    [row] = audit_rows(db, "EMAIL_TEMPLATE_TEST_SENT")
    assert row.meta["kind"] == "VISITOR_INVITATION" and row.meta["draft"] is True
    message = db.get(EmailMessage, email.message_id)
    assert message is not None and message.recipient_user_id == world.a.admin.id and message.visit_id is None
    # There is no way to name another recipient.
    codes = _codes(admin.post(f"{INVITATION}/test", json={"language": "en", "to": "x@example.com"}))
    assert codes["to"]["code"] == "not_allowed"


def test_a_test_that_leads_with_arabic_says_so_in_arabic(admin: Api, email_provider: MemoryProvider) -> None:
    """The prefix was «[تجربة] », "an experiment"; it is «[رسالة تجريبية] », "a test message", the
    words the product's own test e-mail uses (B12-25). The English one is "[Test] " as before."""
    assert admin.post(f"{INVITATION}/test", json={"language": "ar"}).status_code == 202
    assert admin.post(f"{INVITATION}/test", json={"language": "en"}).status_code == 202
    arabic, english = email_provider.sent
    assert arabic.subject.startswith("[رسالة تجريبية] زيارتك إلى Alpha يوم ")
    assert arabic.subject.count("[") == 1 and " | Your visit to Alpha on " in arabic.subject
    assert english.subject.startswith("[Test] Your visit to Alpha on ")
    for email in (arabic, english):
        assert "تجربة]" not in email.subject
        assert f"<title>{email.subject}</title>" in email.html
    # A preview is not a test: no prefix.
    preview = admin.post(f"{INVITATION}/preview", json={"language": "ar"}).json()
    assert preview["subject"].startswith("زيارتك إلى Alpha يوم ")


def test_tests_have_a_budget_per_administrator(
    admin: Api, db: Session, email_provider: MemoryProvider
) -> None:
    for _ in range(5):
        assert admin.post(f"{INVITATION}/test", json={"language": "ar"}).status_code == 202
    response = admin.post(f"{INVITATION}/test", json={"language": "ar"})
    assert response.status_code == 429 and error_code(response) == "RATE_LIMITED"
    assert int(response.headers["retry-after"]) > 0
    assert len(email_provider.sent) == 5
    assert audit_rows(db, "RATE_LIMITED")[-1].meta["policy"] == "template_test_sends_per_user"
    # A refused draft spends nothing.
    assert (
        admin.post(f"{INVITATION}/test", json={"language": "ar", "en": {"intro": "{x}"}}).status_code == 422
    )


# ---- the host's e-mails of a visit (Phase 14, B14-2, B14-14) -------------------------------------------

HOST_KINDS = ("HOST_VISIT_SCHEDULED", "HOST_VISIT_RESCHEDULED", "HOST_VISIT_CANCELLED")


@pytest.mark.parametrize("kind", HOST_KINDS)
@pytest.mark.parametrize("scheme", ["light", "dark"])
def test_the_host_s_e_mails_are_previewed_with_a_draft(admin: Api, kind: str, scheme: str) -> None:
    draft = {"heading": "Draft heading for {host_name}", "intro": "{visitor_name} from {visitor_company}."}
    response = admin.post(f"{BASE}/{kind}/preview", json={"language": "en", "en": draft, "scheme": scheme})
    assert response.status_code == 200, response.text
    preview = response.json()
    assert preview["kind"] == kind and "Sara Ahmad" in preview["subject"]
    assert "Draft heading for" in preview["html"] and "Example Trading" in preview["html"]
    # The document endpoint shows the saved texts (the product's here).
    document = admin.get(f"{BASE}/{kind}/preview", params={"language": "ar", "scheme": scheme})
    assert document.status_code == 200 and document.headers["content-type"].startswith("text/html")


def test_the_host_s_texts_are_used_in_real_e_mails(
    admin: Api, make_client, world: World, clock: FakeClock, email_provider: MemoryProvider
) -> None:
    assert _patch(admin, "HOST_VISIT_SCHEDULED", en={"subject": "Guest: {visitor_name}"}).status_code == 200
    assert (
        _patch(admin, "HOST_VISIT_CANCELLED", en={"intro": "No visit from {visitor_name}."}).status_code
        == 200
    )
    host = signed_in(make_client, world.a.employee)
    visit = create_visit(host, world.a.employee.id, clock.now() + timedelta(hours=2))["visit"]
    host.post(f"/visits/{visit['id']}/cancel", json={})
    scheduled, cancelled = email_provider.sent
    assert scheduled.kind == "HOST_VISIT_SCHEDULED" and scheduled.subject == "Guest: Dana Guest"
    assert cancelled.kind == "HOST_VISIT_CANCELLED" and "No visit from" in cancelled.text
    # Each carries its calendar event all the same.
    assert scheduled.calendar is not None and cancelled.calendar is not None


@pytest.mark.parametrize("kind", ["VISITOR_INVITATION", "VISIT_RESCHEDULED", "VISIT_CANCELLED", *HOST_KINDS])
def test_a_test_e_mail_carries_no_calendar_event(
    admin: Api, kind: str, email_provider: MemoryProvider
) -> None:
    """B14-14: the sample visit exists nowhere; an invitation would put it into the editor's calendar."""
    assert admin.post(f"{BASE}/{kind}/test", json={"language": "en"}).status_code == 202
    [email] = email_provider.sent
    assert email.kind == kind and email.calendar is None
    assert "attached for your calendar" not in email.html + email.text


def test_the_calendar_invitation_has_no_texts_of_its_own(admin: Api) -> None:
    """B14-10: it takes the invitation's words; it is not a kind of the editor."""
    for path in (f"{BASE}/VISITOR_CALENDAR", f"{BASE}/VISITOR_CALENDAR/preview"):
        response = admin.get(path, params={"language": "en"})
        assert response.status_code == 404 and error_code(response) == "NOT_FOUND"
    assert "VISITOR_CALENDAR" not in {item["kind"] for item in admin.get(BASE).json()}
