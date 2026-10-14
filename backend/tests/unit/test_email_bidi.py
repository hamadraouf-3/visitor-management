"""Values isolated from the sentences around them (Phase 10, B10-14): the helpers of `app.email.bidi` and
the catalog's placeholder policy."""

import pytest
from markupsafe import Markup

from app.email.bidi import FSI, LRI, PDI, RLI, direction_of, isolate_html, isolate_text, needs_isolation
from app.email.i18n import (
    FORMATTED_VALUES,
    ISOLATED_VALUES,
    LEFT_TO_RIGHT_VALUES,
    MESSAGES,
    placeholders,
    translate,
    translate_html,
    translate_text,
)
from app.models import Language

HIND = "\N{ARABIC LETTER HAH}\N{ARABIC LETTER NOON}\N{ARABIC LETTER DAL}"  # a name, in Arabic letters
RLM, LRM = "\N{RIGHT-TO-LEFT MARK}", "\N{LEFT-TO-RIGHT MARK}"


@pytest.mark.parametrize(
    ("text", "direction"),
    [
        ("John Smith Jr.", "ltr"),
        (HIND, "rtl"),
        (f"{HIND} Smith", "rtl"),
        (f"3M {HIND}", "ltr"),  # the first strong character decides; digits are not strong
        ("2001:db8::1", "ltr"),
        ("12 34", "ltr"),  # no strong character at all
        ("", "ltr"),
        (f"{RLM}(Sara)", "rtl"),  # a mark is strong
        (f"{LRI}{HIND}{PDI} Smith", "ltr"),  # an isolated run is skipped, as UAX #9 P2 says
        (f"{FSI}{HIND}", "ltr"),  # an isolate left open runs to the end: nothing strong outside it
    ],
)
def test_direction_is_the_first_strong_character(text: str, direction: str) -> None:
    assert direction_of(text) == direction


def test_a_right_to_left_sentence_isolates_every_value_and_a_left_to_right_one_only_what_can_move() -> None:
    for value in ("Omar Khalil", "2001:db8::1", "12", HIND):
        assert needs_isolation(value, "rtl")
    assert not needs_isolation("", "rtl")
    # Without a right-to-left character or a direction control, every character of a left-to-right
    # sentence resolves to the same level: nothing can move, so nothing is wrapped.
    for value in ("Omar Khalil", "Quarterly budget review.", "R&D (Cloud)", "2001:db8::1", "+962 79 500"):
        assert not needs_isolation(value, "ltr")
    for value in (HIND, f"Omar {RLM}", "\N{ARABIC-INDIC DIGIT ONE}2", "a\N{RIGHT-TO-LEFT OVERRIDE}b"):
        assert needs_isolation(value, "ltr")


def test_plain_text_isolates_each_line_of_a_value() -> None:
    assert isolate_text("John Smith Jr.", "rtl") == f"{FSI}John Smith Jr.{PDI}"
    assert isolate_text("2001:db8::1", "rtl", "ltr") == f"{LRI}2001:db8::1{PDI}"
    assert isolate_text(HIND, "ltr", "rtl") == f"{RLI}{HIND}{PDI}"
    assert isolate_text("Omar Khalil", "ltr") == "Omar Khalil"
    # A line break ends every isolate (UAX #9 X8): each line gets its own pair; empty lines stay empty.
    assert isolate_text("Building 14,\r\nKing Abdullah II St.\n\nAmman", "rtl") == (
        f"{FSI}Building 14,{PDI}\r\n{FSI}King Abdullah II St.{PDI}\n\n{FSI}Amman{PDI}"
    )
    # An override left open inside a value ends with the value's PDI instead of reordering the sentence.
    assert isolate_text("a\N{RIGHT-TO-LEFT OVERRIDE}b", "ltr") == f"{FSI}a\N{RIGHT-TO-LEFT OVERRIDE}b{PDI}"


def test_html_isolates_a_value_in_a_span_with_its_direction_and_escapes_it() -> None:
    assert isinstance(isolate_html("John Smith Jr.", "rtl"), Markup)
    assert isolate_html("John Smith Jr.", "rtl") == '<span dir="ltr">John Smith Jr.</span>'
    assert isolate_html(HIND, "rtl") == f'<span dir="rtl">{HIND}</span>'
    assert isolate_html("12", "rtl", "ltr") == '<span dir="ltr">12</span>'
    assert isolate_html("A & B", "ltr") == "A &amp; B"
    hostile = isolate_html('</span><script>alert("x")</script>', "rtl")
    assert hostile == ('<span dir="ltr">&lt;/span&gt;&lt;script&gt;alert(&#34;x&#34;)&lt;/script&gt;</span>')


def test_every_placeholder_has_one_way_into_a_sentence() -> None:
    """A new placeholder must be classified: isolated (names), left to right (addresses) or formatted by the
    service in the sentence's own language (dates and times)."""
    used = {name for texts in MESSAGES.values() for text in texts.values() for name in placeholders(text)}
    sets = (ISOLATED_VALUES, LEFT_TO_RIGHT_VALUES, FORMATTED_VALUES)
    assert used <= ISOLATED_VALUES | LEFT_TO_RIGHT_VALUES | FORMATTED_VALUES
    assert sum(len(names) for names in sets) == len(ISOLATED_VALUES | LEFT_TO_RIGHT_VALUES | FORMATTED_VALUES)


def test_translations_isolate_names_and_addresses_but_not_dates_and_never_subjects() -> None:
    values = {"company": "ACME Inc.", "date": "الاثنين، 5 تشرين الأول 2026", "time": "10:00"}
    values |= {"zone": "بتوقيت عمّان، UTC+3", "ip": "2001:db8:85a3::8a2e:370:7334"}
    text = translate_text(Language.AR, "changed.body.changed_ip", **values)
    assert f"حسابك في {FSI}ACME Inc.{PDI} يوم الاثنين، 5 تشرين الأول 2026 الساعة 10:00 (" in text
    assert f"من عنوان الشبكة {LRI}2001:db8:85a3::8a2e:370:7334{PDI}. " in text
    html = translate_html(Language.AR, "changed.body.changed_ip", **values)
    assert isinstance(html, Markup)
    assert 'حسابك في <span dir="ltr">ACME Inc.</span> يوم الاثنين، 5 تشرين الأول 2026 الساعة 10:00 (' in html
    assert 'من عنوان الشبكة <span dir="ltr">2001:db8:85a3::8a2e:370:7334</span>. ' in html
    # English with Latin values reads exactly as before (the E2E suite reads these sentences).
    english = {"company": "ACME Inc.", "date": "Monday", "time": "10:00", "zone": "Amman time"}
    english |= {"ip": "2001:db8::1"}
    plain = translate(Language.EN, "changed.body.changed_ip", **english)
    assert translate_text(Language.EN, "changed.body.changed_ip", **english) == plain
    assert translate_html(Language.EN, "changed.body.changed_ip", **english) == plain
    # ... and an Arabic name in it is isolated.
    assert translate_text(Language.EN, "common.hello", name=HIND) == f"Hello {FSI}{HIND}{PDI},"
    assert translate_html(Language.EN, "common.hello", name=HIND) == f'Hello <span dir="rtl">{HIND}</span>,'
    # Subjects are headers: `translate` inserts values as they are.
    subject = translate(Language.AR, "arrival.subject", visitor="John Smith Jr.")
    assert subject == "زائرك John Smith Jr. في الاستقبال"


def test_html_translations_escape_the_catalog_text_and_every_value() -> None:
    html = translate_html(Language.EN, "common.hello", name='<b onclick="x">Dana</b>')
    assert html == "Hello &lt;b onclick=&#34;x&#34;&gt;Dana&lt;/b&gt;,"
    with pytest.raises(KeyError):
        translate_html(Language.EN, "common.hello")
    with pytest.raises(ValueError, match="fr"):
        translate_text("fr", "common.hello", name="x")
