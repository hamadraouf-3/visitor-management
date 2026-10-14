"""A company's own e-mail texts (Phase 11, B11-20 to B11-27): the editable fields, the checks of a text,
and how a text and its values are put into an e-mail (escaped, isolated, one-line subjects)."""

import re
import uuid
from datetime import UTC, datetime, timedelta

import pytest

from app.core.config import Settings
from app.core.field_errors import FIELD_CODE_PARAMS, FieldCode
from app.email.editable import (
    EDITABLE,
    PLACEHOLDER,
    check_text,
    default_text,
    editable_kind,
    normalise_text,
    placeholders_of,
    render_html,
    render_subject,
    render_text,
)
from app.email.i18n import MESSAGES, placeholders
from app.email.rendering import EmailRenderer
from app.email.service import NO_BRAND_IMAGES, NO_TEMPLATE_TEXTS, EmailService
from app.models import EDITABLE_EMAIL_KINDS, Company, EmailKind, Language, TemplateField, Visit

AR, EN = Language.AR, Language.EN
FSI = "\N{FIRST STRONG ISOLATE}"
PDI = "\N{POP DIRECTIONAL ISOLATE}"
START = datetime(2026, 10, 6, 7, 0, tzinfo=UTC)
INVITATION = EDITABLE[EmailKind.VISITOR_INVITATION]
ARRIVAL = EDITABLE[EmailKind.HOST_ARRIVAL]


def _field(kind: EmailKind, name: TemplateField):
    field = EDITABLE[kind].field(name)
    assert field is not None
    return field


# ---- the definitions ---------------------------------------------------------------------------------


def test_the_editable_kinds_are_the_visit_e_mails_and_never_the_security_ones() -> None:
    assert tuple(EDITABLE) == EDITABLE_EMAIL_KINDS
    assert set(EDITABLE) == {
        EmailKind.VISITOR_INVITATION,
        EmailKind.VISIT_RESCHEDULED,
        EmailKind.VISIT_CANCELLED,
        EmailKind.HOST_ARRIVAL,
    }
    assert editable_kind("PASSWORD_RESET") is None
    assert editable_kind("PASSWORD_CHANGED") is None
    assert editable_kind("NOT_A_KIND") is None
    assert editable_kind("HOST_ARRIVAL") is ARRIVAL


@pytest.mark.parametrize("kind", list(EDITABLE), ids=str)
def test_every_default_text_uses_only_the_kind_s_variables(kind: EmailKind) -> None:
    spec = EDITABLE[kind]
    for field in spec.fields:
        if field.catalog_key is None:
            assert default_text(field, AR) == default_text(field, EN) == ""
            continue
        catalog = placeholders(MESSAGES[field.catalog_key][EN])
        # Every catalog placeholder is renamed to a documented variable (or already is one).
        assert {field.rename.get(name, name) for name in catalog} <= set(spec.variables), field.name
        for language in (AR, EN):
            text = default_text(field, language)
            assert set(placeholders_of(text)) <= set(spec.variables)
            assert set(field.required) <= set(placeholders_of(text))  # the product's own text passes
            assert check_text(field, spec, text) is None, (kind, field.name, language)


def test_the_documented_variables_and_fields() -> None:
    assert INVITATION.variables == (
        "visitor_name",
        "company",
        "host_name",
        "date",
        "time",
        "timezone",
        "department",
        "purpose",
    )
    assert [field.name.value for field in INVITATION.fields] == [
        "subject",
        "heading",
        "greeting",
        "intro",
        "button",
        "closing",
        "footer_note",
    ]
    assert EDITABLE[EmailKind.VISIT_RESCHEDULED].field(TemplateField.BUTTON) is None
    assert "visitor_company" in ARRIVAL.variables
    assert _field(EmailKind.VISITOR_INVITATION, TemplateField.SUBJECT).required == ("company",)
    assert _field(EmailKind.HOST_ARRIVAL, TemplateField.SUBJECT).required == ("visitor_name",)
    assert default_text(_field(EmailKind.VISITOR_INVITATION, TemplateField.GREETING), EN) == (
        "Hello {visitor_name},"
    )
    assert default_text(_field(EmailKind.HOST_ARRIVAL, TemplateField.INTRO), EN) == (
        "Your visitor {visitor_name} has arrived and checked in at reception at {time} ({timezone})."
    )


def test_the_new_field_codes_carry_their_parameters() -> None:
    assert FIELD_CODE_PARAMS[FieldCode.UNKNOWN_PLACEHOLDER] == ("allowed", "name")
    assert FIELD_CODE_PARAMS[FieldCode.PLACEHOLDER_REQUIRED] == ("name",)
    assert FieldCode.INVALID_PLACEHOLDER not in FIELD_CODE_PARAMS
    assert FieldCode.MARKUP_NOT_ALLOWED not in FIELD_CODE_PARAMS


# ---- checks --------------------------------------------------------------------------------------------


def _problem(kind: EmailKind, name: TemplateField, text: str):
    return check_text(_field(kind, name), EDITABLE[kind], text)


@pytest.mark.parametrize(
    ("name", "text", "code"),
    [
        (TemplateField.INTRO, "Welcome {visitor_name}, see you on {date}.", None),
        (TemplateField.INTRO, "Line one\nLine two with {host_name}", None),
        (TemplateField.INTRO, "R&D and a < b stay plain text", None),
        (TemplateField.INTRO, "Hello {visitors_name}", FieldCode.UNKNOWN_PLACEHOLDER),
        (TemplateField.INTRO, "Hello {VISITOR_NAME}", FieldCode.INVALID_PLACEHOLDER),
        (TemplateField.INTRO, "Hello {visitor_name.__class__}", FieldCode.INVALID_PLACEHOLDER),
        (TemplateField.INTRO, "Hello {visitor_name!r}", FieldCode.INVALID_PLACEHOLDER),
        (TemplateField.INTRO, "Hello {visitor_name:>99}", FieldCode.INVALID_PLACEHOLDER),
        (TemplateField.INTRO, "A lone { brace", FieldCode.INVALID_PLACEHOLDER),
        (TemplateField.INTRO, "{{visitor_name}}", FieldCode.INVALID_PLACEHOLDER),
        (TemplateField.INTRO, "Bold <b>text</b>", FieldCode.MARKUP_NOT_ALLOWED),
        (TemplateField.INTRO, "</p><script>x</script>", FieldCode.MARKUP_NOT_ALLOWED),
        (TemplateField.INTRO, "An &amp; entity", FieldCode.MARKUP_NOT_ALLOWED),
        (TemplateField.INTRO, "A &#60; reference", FieldCode.MARKUP_NOT_ALLOWED),
        (TemplateField.INTRO, "<!-- comment -->", FieldCode.MARKUP_NOT_ALLOWED),
        (TemplateField.INTRO, "Tab\there", FieldCode.CONTROL_CHARACTERS),
        (TemplateField.INTRO, "Bell\x07", FieldCode.CONTROL_CHARACTERS),
        (TemplateField.INTRO, "Next\N{LINE SEPARATOR}line", FieldCode.CONTROL_CHARACTERS),
        (TemplateField.INTRO, "C1\x85control", FieldCode.CONTROL_CHARACTERS),
        (TemplateField.INTRO, "Text\N{RIGHT-TO-LEFT OVERRIDE}reversed", FieldCode.BIDI_CONTROLS),
        (TemplateField.INTRO, "Isolate\N{FIRST STRONG ISOLATE}x", FieldCode.BIDI_CONTROLS),
        (TemplateField.INTRO, "x" * 1001, FieldCode.TOO_LONG),
        (TemplateField.SUBJECT, "Visit to {company}\nBcc: someone@example.com", FieldCode.LINE_BREAKS),
        (TemplateField.SUBJECT, "Visit to\t{company}", FieldCode.LINE_BREAKS),
        (TemplateField.SUBJECT, "Your visit on {date}", FieldCode.PLACEHOLDER_REQUIRED),
        (TemplateField.SUBJECT, "Your visit to {company} on {date}", None),
        (TemplateField.BUTTON, "x" * 41, FieldCode.TOO_LONG),
    ],
)
def test_the_checks_of_a_text(name: TemplateField, text: str, code: FieldCode | None) -> None:
    problem = _problem(EmailKind.VISITOR_INVITATION, name, text)
    assert (problem.code if problem else None) == code


def test_an_unknown_placeholder_names_itself_and_the_allowed_variables() -> None:
    problem = _problem(EmailKind.VISITOR_INVITATION, TemplateField.INTRO, "Hi {name} from {company}")
    assert problem is not None
    assert problem.detail() == {
        "code": "unknown_placeholder",
        "params": {"allowed": list(INVITATION.variables), "name": "name"},
    }
    required = _problem(EmailKind.HOST_ARRIVAL, TemplateField.SUBJECT, "Someone arrived")
    assert required is not None
    assert required.detail() == {"code": "placeholder_required", "params": {"name": "visitor_name"}}


def test_a_host_arrival_text_cannot_use_the_visitor_e_mails_variables() -> None:
    problem = _problem(EmailKind.HOST_ARRIVAL, TemplateField.INTRO, "In {department}")
    assert problem is not None and problem.code == FieldCode.UNKNOWN_PLACEHOLDER


def test_normalising_a_text() -> None:
    assert normalise_text("  one\r\ntwo\rthree\n ") == "one\ntwo\nthree"
    assert PLACEHOLDER.findall("{a} {b_2} {C}") == ["a", "b_2"]


# ---- rendering -----------------------------------------------------------------------------------------


VALUES = {
    "visitor_name": "Dana <script>alert(1)</script> & Co.",
    "company": "أكمي",
    "date": "Tuesday, 6 October 2026",
    "time": "10:00 to 11:00",
    "host_name": "Omar",
}


def test_html_escapes_the_text_and_every_value_and_keeps_line_breaks() -> None:
    html = str(render_html("Hi {visitor_name}\nfrom {company} on {date} <3", VALUES, EN))
    assert "<script>" not in html
    assert "Dana &lt;script&gt;alert(1)&lt;/script&gt; &amp; Co." in html
    assert "<br>" in html
    assert "&lt;3" in html
    # The Arabic company keeps its own direction in an English sentence; the date is inserted as it is.
    assert '<span dir="rtl">أكمي</span>' in html
    assert "on Tuesday, 6 October 2026" in html


def test_an_arabic_sentence_isolates_every_name_but_not_the_formatted_values() -> None:
    html = str(render_html("مرحبًا {host_name}، موعدك {time}", VALUES, AR))
    assert '<span dir="ltr">Omar</span>' in html
    assert "10:00 to 11:00" in html and 'dir="ltr">10:00' not in html
    text = render_text("مرحبًا {host_name}، موعدك {time}", VALUES, AR)
    assert f"{FSI}Omar{PDI}" in text
    assert f"{FSI}10:00" not in text


def test_a_value_that_ends_a_sentence_takes_the_place_of_the_text_s_full_stop() -> None:
    text = render_text("Meet {visitor_name}.", VALUES, EN)
    assert text.endswith("Co.")
    assert not text.endswith("Co..")


def test_a_subject_is_one_line_with_values_as_they_are() -> None:
    subject = render_subject(
        "Visit to {company}: {visitor_name}", {**VALUES, "visitor_name": "A\r\nBcc: x@y"}
    )
    assert "\n" not in subject and "\r" not in subject
    assert subject == "Visit to أكمي: A Bcc: x@y"
    assert FSI not in subject and "<span" not in subject


def test_an_unknown_variable_renders_empty_rather_than_failing() -> None:
    # Saved texts were checked against the allow-list; a value the service does not supply prints nothing.
    assert render_text("[{department}]", {}, EN) == "[]"


# ---- the e-mail service with a company's texts -------------------------------------------------------------


class _Messages:
    def add(self, message):
        return message


class _Texts:
    def __init__(self, texts):
        self.texts_by_kind = texts

    def texts(self, company_id, kind):
        return self.texts_by_kind.get(str(kind), {})


def _service(texts) -> EmailService:
    settings = Settings(
        _env_file=None,  # type: ignore[call-arg]
        app_env="test",
        database_url="postgresql://u:p@h/d",
        app_base_url="https://vms.test",
        email_from="Demo Visitors <visitors@demo.test>",
    )
    service = EmailService(
        None,  # type: ignore[arg-type]
        settings=settings,
        renderer=EmailRenderer(),
        provider_name="memory",
        template_texts=_Texts(texts),
        brand_images=NO_BRAND_IMAGES,
    )
    service.messages = _Messages()  # type: ignore[assignment]
    return service


def _company() -> Company:
    return Company(
        id=uuid.uuid4(),
        name="Acme Holding",
        name_ar="أكمي القابضة",
        slug="acme",
        timezone="Asia/Amman",
        address="Building 14",
        notify_host_on_check_in=True,
        default_language="en",
    )


def _visit(company: Company, **changes) -> Visit:
    values = {
        "id": uuid.uuid4(),
        "company_id": company.id,
        "visitor_id": uuid.uuid4(),
        "host_id": uuid.uuid4(),
        "visitor_name": "Dana <b>Guest</b>",
        "visitor_company_name": "Acme",
        "host_name": "Omar Khalil",
        "department_name": "Finance",
        "department_name_ar": "المالية",
        "purpose": "Quarterly review",
        "scheduled_start": START,
        "scheduled_end": START + timedelta(hours=1),
        "window_start": START - timedelta(hours=1),
        "window_end": START + timedelta(hours=2),
    }
    values.update(changes)
    return Visit(**values)


EDITED = {
    "VISITOR_INVITATION": {
        EN: {
            "subject": "Welcome to {company}, {visitor_name}",
            "heading": "See you soon at {company}",
            "greeting": "Dear {visitor_name},",
            "intro": "Our colleague {host_name} expects you in {department}.\nParking is free.",
            "button": "Show my pass",
            "closing": "Thank you for visiting.",
            "footer_note": "Acme Holding, Amman",
        }
    }
}


def test_the_company_s_texts_replace_only_the_fields_it_edited() -> None:
    company = _company()
    job = _service(EDITED).queue_visitor_invitation(
        _visit(company), "t" * 43, company=company, recipient="dana@example.com", host_email=None
    )
    email = job.email
    # The English half of the bilingual subject is the company's; the Arabic half the product's.
    english, arabic = email.subject.split(" | ")
    assert english == "Welcome to Acme Holding, Dana <b>Guest</b>"
    assert arabic.startswith("زيارتك إلى أكمي القابضة")
    for text in (
        "See you soon at",
        "Dear",
        "Parking is free.",
        "Show my pass",
        "Thank you for visiting.",
        "Amman",
    ):
        assert text in email.html and (text in email.text or text == "Show my pass")
    assert "Our colleague Omar Khalil expects you in Finance." in email.text
    assert "Parking is free.<br>" not in email.html  # the line break is a <br> between the two lines
    assert "expects you in Finance.<br>Parking is free." in email.html
    # The visitor's name stays escaped, wherever a text puts it.
    assert "<b>Guest</b>" not in email.html
    assert "Dana &lt;b&gt;Guest&lt;/b&gt;" in email.html
    # What stays the product's: the pass, its link, the personal-pass line, the details grid.
    assert "This pass is personal. Please do not forward this email." in email.html
    assert "cid:visitor-pass-qr" in email.html
    assert email.pass_url is not None and email.pass_url in email.html
    assert "Has invited you" not in email.html
    assert "has invited you to visit" not in email.text.split("----")[0]  # the English intro is replaced
    assert "تلقّيت دعوةً من" in email.text  # the Arabic intro is the product's


def test_without_texts_of_its_own_a_company_s_e_mail_is_the_product_s() -> None:
    company = _company()
    visit = _visit(company)
    plain = _service({}).queue_visitor_invitation(
        visit, "t" * 43, company=company, recipient="dana@example.com", host_email=None
    )
    default = (
        EmailService(
            None,  # type: ignore[arg-type]
            settings=_service({}).settings,
            renderer=EmailRenderer(),
            provider_name="memory",
            template_texts=NO_TEMPLATE_TEXTS,
            brand_images=NO_BRAND_IMAGES,
        )
        .prepare_visitor_invitation(visit, plain.email.pass_url or "", company=company, host_email=None)
        .rendered
    )
    assert (plain.email.subject, plain.email.html, plain.email.text) == (
        default.subject,
        default.html,
        default.text,
    )


def test_a_host_arrival_with_the_company_s_texts() -> None:
    company = _company()
    texts = {
        "HOST_ARRIVAL": {
            EN: {
                "subject": "{visitor_name} is here",
                "intro": "{visitor_name} from {visitor_company} arrived at {time}.",
                "closing": "Reception: extension 100",
            }
        }
    }
    from app.models import User

    host = User(
        id=uuid.uuid4(),
        company_id=company.id,
        full_name="Omar Khalil",
        email="omar@example.com",
        preferred_language="en",
        roles=["EMPLOYEE"],
    )
    visit = _visit(company, check_in_at=START + timedelta(minutes=5))
    email = _service(texts).queue_host_arrival(visit, company=company, host=host).email
    assert email.subject == "Dana <b>Guest</b> is here"
    assert "from Acme arrived at 10:05." in email.text
    assert "Reception: extension 100" in email.html
    assert re.search(r"Please meet your visitor at reception", email.html)  # the product's line stays
