"""The language of the e-mails the API sends (Phase 10, B10-9), end to end through the API, the
dispatcher and the memory provider.

Visitor e-mails lead with the company's default language and name the company by its Arabic name in the
Arabic text; staff e-mails lead with the recipient's own language, else the company's."""

from datetime import timedelta

from sqlalchemy.orm import Session

from app.email.bidi import FSI, PDI
from app.email.providers.memory import MemoryProvider
from app.email.service import QR_CONTENT_ID
from app.models import Company, Role
from tests.conftest import TEST_START
from tests.support import Factory, check_in, create_visit, signed_in

START = TEST_START + timedelta(hours=1)  # 10:00 in Asia/Amman
VISITOR = {"full_name": "Dana Guest", "email": "dana.guest@example.com", "company_name": "Acme"}


def _tenant(factory: Factory, *, default_language: str, host_language: str | None = None):
    company = factory.company("Mawdoo3", name_ar="موضوع", default_language=default_language)
    host = factory.user(company, full_name="Omar Khalil", preferred_language=host_language)
    reception = factory.user(company, roles=(Role.RECEPTIONIST,))
    return company, host, reception


def _sent(provider: MemoryProvider, kind: str):
    return [email for email in provider.sent if email.kind == kind]


def test_an_arabic_company_invites_in_arabic_first(
    make_client, factory: Factory, email_provider: MemoryProvider
) -> None:
    _company, host, _reception = _tenant(factory, default_language="ar")
    create_visit(signed_in(make_client, host), host.id, START, visitor=VISITOR, send_invitation=True)

    (invitation,) = _sent(email_provider, "VISITOR_INVITATION")
    assert invitation.subject == (
        "زيارتك إلى موضوع يوم الاثنين، 5 تشرين الأول 2026 | Your visit to Mawdoo3 on Monday, 5 October 2026"
    )
    assert invitation.html.startswith('<!DOCTYPE html>\n<html lang="ar" dir="rtl"')
    # A Latin name in the Arabic text is isolated (B10-14); the English text is as it was.
    assert invitation.text.index(f"مرحبًا {FSI}Dana Guest{PDI}،") < invitation.text.index("Hello Dana Guest,")
    assert 'مرحبًا <span dir="ltr">Dana Guest</span>،' in invitation.html
    # The English section keeps what the E2E suite reads from the text body.
    for expected in ("Hello Dana Guest", "Host: Omar Khalil", "Quarterly review", invitation.pass_url or "?"):
        assert expected in invitation.text
    # The company has no logo: the QR code is the only image (B12-12).
    assert [image.content_id for image in invitation.inline_images] == [QR_CONTENT_ID]


def test_an_english_company_invites_in_english_first(
    make_client, factory: Factory, email_provider: MemoryProvider
) -> None:
    _company, host, _reception = _tenant(factory, default_language="en")
    create_visit(signed_in(make_client, host), host.id, START, visitor=VISITOR, send_invitation=True)
    (invitation,) = _sent(email_provider, "VISITOR_INVITATION")
    assert invitation.subject.startswith("Your visit to Mawdoo3 on Monday, 5 October 2026 | زيارتك إلى موضوع")
    assert invitation.text.index("Hello Dana Guest,") < invitation.text.index(f"مرحبًا {FSI}Dana Guest{PDI}،")


def test_changing_the_default_language_changes_the_next_invitation(
    make_client, factory: Factory, email_provider: MemoryProvider, db: Session
) -> None:
    company, host, _reception = _tenant(factory, default_language="en")
    admin = factory.user(company, roles=(Role.SYSTEM_ADMIN,))
    response = signed_in(make_client, admin).patch("/company/settings", json={"default_language": "ar"})
    assert response.status_code == 200
    create_visit(signed_in(make_client, host), host.id, START, visitor=VISITOR, send_invitation=True)
    (invitation,) = _sent(email_provider, "VISITOR_INVITATION")
    assert invitation.subject.startswith("زيارتك إلى موضوع")
    db.expire_all()
    assert db.get(Company, company.id).default_language == "ar"  # type: ignore[union-attr]


def test_the_host_arrival_follows_the_hosts_own_language(
    make_client, factory: Factory, email_provider: MemoryProvider
) -> None:
    """An English company, a host who chose Arabic: the notice to the host leads in Arabic, while the
    visitor's invitation leads in the company's English."""
    _company, host, reception = _tenant(factory, default_language="en", host_language="ar")
    created = create_visit(
        signed_in(make_client, host), host.id, START, visitor=VISITOR, send_invitation=True
    )
    response = check_in(signed_in(make_client, reception), created["visit"]["id"])
    assert response.status_code == 200, response.text

    (arrival,) = _sent(email_provider, "HOST_ARRIVAL")
    assert arrival.subject == "زائرك Dana Guest في الاستقبال"
    arabic = arrival.text.index(f"زائرك {FSI}Dana Guest{PDI} في الاستقبال، وقد سُجّل الدخول")
    assert arabic < arrival.text.index("Your visitor Dana Guest has arrived and checked in")
    (invitation,) = _sent(email_provider, "VISITOR_INVITATION")
    assert invitation.subject.startswith("Your visit to Mawdoo3")


def test_a_host_without_a_preference_gets_the_company_language(
    make_client, factory: Factory, email_provider: MemoryProvider
) -> None:
    _company, host, reception = _tenant(factory, default_language="ar")
    created = create_visit(signed_in(make_client, host), host.id, START, visitor=VISITOR)
    assert check_in(signed_in(make_client, reception), created["visit"]["id"]).status_code == 200
    (arrival,) = _sent(email_provider, "HOST_ARRIVAL")
    assert arrival.subject == "زائرك Dana Guest في الاستقبال"
    assert "Your visitor Dana Guest has arrived and checked in" in arrival.text  # E2E reads this


def test_the_department_and_the_address_reach_each_language_through_the_api(
    make_client, factory: Factory, email_provider: MemoryProvider
) -> None:
    """B10-26 end to end: the Arabic text shows the department's Arabic name and the Arabic address set in
    the administration pages, the English text the department's name and the address; a rename of the
    Arabic name reaches the reschedule notice of the SCHEDULED visit (D-17)."""
    company, host, _reception = _tenant(factory, default_language="ar")
    finance = factory.department(company, "Finance")
    admin = signed_in(make_client, factory.user(company, roles=(Role.SYSTEM_ADMIN,)))
    named = admin.patch(f"/departments/{finance.id}", json={"name_ar": "المالية"})
    assert named.status_code == 200, named.text
    settings = admin.patch(
        "/company/settings", json={"address": "Amman, Jordan", "address_ar": "عمّان، الأردن"}
    )
    assert settings.status_code == 200, settings.text
    api = signed_in(make_client, host)
    body = {"visitor": VISITOR, "send_invitation": True, "department_id": str(finance.id)}
    visit = create_visit(api, host.id, START, **body)["visit"]
    assert visit["department"] == {"id": str(finance.id), "name": "Finance", "name_ar": "المالية"}

    (invitation,) = _sent(email_provider, "VISITOR_INVITATION")
    english = invitation.text[invitation.text.index("Hello Dana Guest,") :]
    arabic = invitation.text[: invitation.text.index("Hello Dana Guest,")]
    assert f"القسم: {FSI}المالية{PDI}" in arabic and f"العنوان: {FSI}عمّان، الأردن{PDI}" in arabic
    assert "Department: Finance\n" in english and "Address: Amman, Jordan\n" in english
    assert "المالية" not in english and "Finance" not in arabic

    assert admin.patch(f"/departments/{finance.id}", json={"name_ar": "الخزينة"}).status_code == 200
    moved = api.patch(
        f"/visits/{visit['id']}",
        json={
            "scheduled_start": (START + timedelta(hours=1)).isoformat(),
            "scheduled_end": (START + timedelta(hours=2)).isoformat(),
        },
    )
    assert moved.status_code == 200, moved.text
    (notice,) = _sent(email_provider, "VISIT_RESCHEDULED")
    assert f"القسم: {FSI}الخزينة{PDI}" in notice.text and "Department: Finance\n" in notice.text
