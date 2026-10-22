"""The tracking alert e-mail (Phase 16, B16-14) without a database: its subject in the recipient's language
only, "[Simulated]" for the simulator's, the place with "Restricted" beside a restricted zone, the time in
the company's time zone, the allowed floors or "Not set", the right link for the right recipient, both
languages in full, and nothing that opens a pass."""

import uuid
from datetime import UTC, datetime

import pytest

from app.core.config import Settings
from app.email.rendering import EmailRenderer
from app.email.service import NO_BRAND_IMAGES, NO_TEMPLATE_TEXTS, AlertFacts, EmailService
from app.models import Company, EmailKind, Language

SEEN = datetime(2026, 10, 21, 7, 30, tzinfo=UTC)  # 10:30 in Amman
VISIT = uuid.UUID("11111111-2222-3333-4444-555555555555")


class _Messages:
    def add(self, message):
        return message


def _service() -> EmailService:
    settings = Settings(
        _env_file=None,  # type: ignore[call-arg]
        app_env="test",
        database_url="postgresql://u:p@h/d",
        app_base_url="https://visitors.test",
        email_from="Visitors <visitors@demo.test>",
    )
    service = EmailService(
        None,  # type: ignore[arg-type]
        settings=settings,
        renderer=EmailRenderer(),
        provider_name="memory",
        template_texts=NO_TEMPLATE_TEXTS,
        brand_images=NO_BRAND_IMAGES,
    )
    service.messages = _Messages()  # type: ignore[assignment]
    return service


def _company(**changes: object) -> Company:
    values: dict[str, object] = {
        "id": uuid.uuid4(),
        "name": "Acme Holding",
        "name_ar": "أكمي القابضة",
        "slug": "acme",
        "timezone": "Asia/Amman",
        "default_language": "en",
    }
    values.update(changes)
    return Company(**values)


def _facts(**changes: object) -> AlertFacts:
    values: dict[str, object] = {
        "alert_type": "UNAUTHORIZED_AREA",
        "simulated": False,
        "visitor_name": "Dana Guest",
        "visitor_company_name": "Globex",
        "host_name": "Omar Khalil",
        "place": {
            Language.EN: "Tower \u203a Fourth \u203a Open office",
            Language.AR: "البرج \u203a الرابع \u203a المكاتب",
        },
        "restricted": False,
        "seen_at": SEEN,
        "allowed_floors": {Language.EN: "Second", Language.AR: "الثاني"},
        "allowed_zones": {Language.EN: None, Language.AR: None},
    }
    values.update(changes)
    return AlertFacts(**values)  # type: ignore[arg-type]


def _queue(
    facts: AlertFacts, *, language: str | None = None, link: str = "journey", company: Company | None = None
):
    company = company or _company()
    return (
        _service()
        .queue_tracking_alert(
            facts,
            company=company,
            to="Guard@Example.com",
            language=language,
            link=link,
            visit_id=VISIT,  # type: ignore[arg-type]
        )
        .email
    )


def test_an_unauthorized_area_for_the_alert_addresses() -> None:
    email = _queue(_facts())
    assert email.kind is EmailKind.TRACKING_ALERT and email.to == "guard@example.com"
    assert email.subject == "Tracking alert: Dana Guest is outside the allowed areas"
    text = email.text
    assert "A visitor is outside the allowed areas" in text
    assert "Open the visitor's journey" in text
    assert f"https://visitors.test/journey/{VISIT}?c=acme" in text and f"/journey/{VISIT}" in email.html
    assert "10:30" in text and "Second" in text and "Globex" in text and "Omar Khalil" in text
    # Both languages in full, the leading one first.
    assert text.index("A visitor is outside the allowed areas") < text.index("زائر خارج المناطق المسموحة")
    assert "Simulated" not in text and "Restricted" not in text
    for forbidden in ("/pass", "#token", "trk_", "vtk_"):
        assert forbidden not in text and forbidden not in email.html
    assert "Sent by Acme Holding." in text  # the company's own e-mail


def test_a_restricted_area_for_the_host_in_arabic() -> None:
    email = _queue(
        _facts(
            alert_type="RESTRICTED_AREA",
            restricted=True,
            place={
                Language.EN: "Tower \u203a Fourth \u203a Server room",
                Language.AR: "البرج \u203a الرابع \u203a غرفة الخوادم",
            },
        ),
        language="ar",
        link="visit",
    )
    assert email.subject == "تنبيه تتبّع: Dana Guest في منطقة مقيّدة"
    text = email.text
    assert "غرفة الخوادم (مقيّدة)" in text and "Server room (Restricted)" in text
    assert text.index("زائر في منطقة مقيّدة") < text.index("A visitor is in a restricted area")
    assert f"https://visitors.test/visits/{VISIT}?c=acme" in text
    assert "/journey/" not in text and "/journey/" not in email.html
    assert "فتح الزيارة" in text and "Open the visit" in text
    assert 'dir="rtl"' in email.html


@pytest.mark.parametrize(("language", "prefix"), [("en", "[Simulated] "), ("ar", "[محاكاة] ")])
def test_the_simulator_s_alert_says_so(language: str, prefix: str) -> None:
    email = _queue(_facts(simulated=True), language=language)
    assert email.subject.startswith(prefix)
    assert "Simulated data, not from a real tracking provider." in email.text
    assert "بيانات محاكاة" in email.text


def test_areas_not_set_and_extra_zones() -> None:
    nothing = _queue(
        _facts(
            alert_type="RESTRICTED_AREA",
            restricted=True,
            allowed_floors={Language.EN: None, Language.AR: None},
            allowed_zones={Language.EN: None, Language.AR: None},
        )
    )
    assert "Allowed floors: Not set" in nothing.text.replace("⁨", "").replace("⁩", "")
    assert "غير محددة" in nothing.text and "Extra zones" not in nothing.text
    zones = _queue(
        _facts(
            allowed_floors={Language.EN: None, Language.AR: None},
            allowed_zones={Language.EN: "Meeting rooms", Language.AR: "قاعات الاجتماعات"},
        )
    )
    plain = zones.text.replace("⁨", "").replace("⁩", "")
    assert "Extra zones: Meeting rooms" in plain and "Allowed floors" not in plain


def test_the_time_is_the_company_s() -> None:
    utc = _queue(_facts(), company=_company(timezone="UTC"))
    assert "07:30" in utc.text and "10:30" not in utc.text
