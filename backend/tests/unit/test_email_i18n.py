"""The e-mail catalog (Phase 10, B10-7): every text exists in both languages with the same placeholders,
reads in its own script, and the helpers pick languages and count minutes correctly."""

import re

import pytest

from app.email.i18n import (
    DIRECTION,
    LANGUAGE_NAMES,
    MESSAGES,
    as_language,
    minutes,
    other_language,
    placeholders,
    translate,
    translate_html,
    translate_text,
)
from app.models import Language

ARABIC_LETTER = re.compile("[\u0621-\u064a]")
# Characters that hide or reorder text; the catalog must not depend on them.
INVISIBLE = re.compile("[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]")
ARABIC_INDIC_DIGITS = re.compile("[\u0660-\u0669\u06f0-\u06f9]")


@pytest.mark.parametrize("key", sorted(MESSAGES))
def test_every_text_exists_in_both_languages_with_the_same_placeholders(key: str) -> None:
    texts = MESSAGES[key]
    assert set(texts) == {Language.AR, Language.EN}
    assert placeholders(texts[Language.AR]) == placeholders(texts[Language.EN])
    for text in texts.values():
        assert text == text.strip() and "  " not in text
        assert not INVISIBLE.search(text) and not ARABIC_INDIC_DIGITS.search(text)


@pytest.mark.parametrize("key", sorted(MESSAGES))
def test_arabic_texts_are_arabic_and_start_with_an_arabic_word(key: str) -> None:
    """A mail client that takes a paragraph's direction from its first letter lays the Arabic text out
    right to left, even when a Latin name follows (B10-7)."""
    arabic = MESSAGES[key][Language.AR]
    assert ARABIC_LETTER.search(arabic), key
    first_letter = next(character for character in arabic if character.isalpha() or character == "{")
    assert first_letter != "{" and ARABIC_LETTER.match(first_letter), key


# Fathatan written after the alif ("مرحباً"); the interface's catalogs write it on the letter before
# ("مرحبًا"), and the e-mails follow the same spelling (phase 10 review).
TANWEEN_AFTER_ALIF = re.compile("اً")


@pytest.mark.parametrize("key", sorted(MESSAGES))
def test_arabic_texts_write_tanween_as_the_interface_does(key: str) -> None:
    assert not TANWEEN_AFTER_ALIF.search(MESSAGES[key][Language.AR]), key


# Checking in is «تسجيل الدخول», the interface's term (phase 10 review: the e-mails said «تسجيل الوصول»).
CHECK_IN_AS_ARRIVAL = re.compile(r"(?:تسجيل|سجّل|سُجّل|يسجّل|سيسجّل)\s+وصول")


@pytest.mark.parametrize("key", sorted(MESSAGES))
def test_arabic_texts_say_checking_in_as_the_interface_does(key: str) -> None:
    assert not CHECK_IN_AS_ARRIVAL.search(MESSAGES[key][Language.AR]), key


def test_arabic_texts_name_the_administrator_as_the_interface_does() -> None:
    """The administrator, one person, is «مدير النظام», the interface's name for the role beside a
    person and its error's (`LAST_ADMIN`); «مسؤول النظام» was a second word for the same person
    (phase 10 final touches)."""
    assert [key for key, texts in MESSAGES.items() if "مسؤول النظام" in texts[Language.AR]] == []
    assert "مدير النظام" in translate(Language.AR, "changed.act")


def test_english_keeps_the_wording_of_the_e_mails_before_phase_10() -> None:
    # What the E2E suite reads from the text part (B10-7), unchanged by the trimming of B10-19.
    assert (
        translate(Language.EN, "invitation.present_above")
        == "Please present the QR code above at reception when you arrive."
    )
    assert (
        translate(Language.EN, "label.host") == "Host"
        and translate(Language.EN, "label.department") == "Department"
    )
    assert translate(Language.EN, "common.hello", name="Dana") == "Hello Dana,"
    assert (
        translate(Language.EN, "arrival.body", visitor="Dana", time="10:03", zone="Amman time")
        == "Your visitor Dana has arrived and checked in at reception at 10:03 (Amman time)."
    )
    assert translate(Language.EN, "invitation.open_pass") == "Open my visitor pass"


def test_translate_inserts_values_and_refuses_holes() -> None:
    assert translate("ar", "common.hello", name="هند") == "مرحبًا هند،"
    with pytest.raises(KeyError):
        translate(Language.EN, "common.hello")  # a value the text needs
    with pytest.raises(KeyError):
        translate(Language.EN, "no.such.key")
    with pytest.raises(ValueError, match="fr"):
        translate("fr", "common.hello", name="x")


def test_language_helpers() -> None:
    assert other_language(Language.AR) == Language.EN and other_language(Language.EN) == Language.AR
    assert DIRECTION == {Language.AR: "rtl", Language.EN: "ltr"}
    assert LANGUAGE_NAMES[Language.AR] == "العربية" and LANGUAGE_NAMES[Language.EN] == "English"
    # The user's preference, else the company's default, else Arabic (the product's default).
    assert as_language("en", "ar") == Language.EN
    assert as_language(None, "en") == Language.EN
    assert as_language(None, None) == Language.AR
    assert as_language("fr", "xx") == Language.AR


@pytest.mark.parametrize(
    ("count", "english", "arabic"),
    [
        (1, "1 minute", "دقيقة واحدة"),
        (2, "2 minutes", "دقيقتين"),
        (3, "3 minutes", "3 دقائق"),
        (10, "10 minutes", "10 دقائق"),
        (11, "11 minutes", "11 دقيقة"),
        (30, "30 minutes", "30 دقيقة"),
    ],
)
def test_minutes_follow_each_languages_number_agreement(count: int, english: str, arabic: str) -> None:
    assert minutes(Language.EN, count) == english
    assert minutes(Language.AR, count) == arabic


# ---- explanatory filler removed, and one full stop per sentence (B10-19) -------------------------------


def test_the_explanatory_filler_is_gone_from_the_catalog() -> None:
    removed = {
        "footer.automated",
        "footer.automated_for",
        "invitation.present",
        "invitation.qr_missing",
        "invitation.text_qr",
        "invitation.tip_label",
        "invitation.tip",
        "changed.ok",
        "test.sample",
        "test.sample_above",
        "test.footer",
    }
    assert removed.isdisjoint(MESSAGES)
    for text in (MESSAGES[key][Language.EN] for key in MESSAGES):
        assert "Here are the details" not in text and "These are the new details" not in text
        assert "Select the button below" not in text


@pytest.mark.parametrize("company", ["ACME Inc.", "Yes!", "Who?", "Etc…"])
def test_a_sentence_ending_with_a_value_that_ends_a_sentence_has_one_full_stop(company: str) -> None:
    english = translate(Language.EN, "footer.company", company=company)
    assert english == f"Sent by {company}"
    arabic = translate_text(Language.AR, "footer.company", company=company)
    assert not arabic.endswith(".") and arabic.endswith("⁩")
    html = translate_html(Language.EN, "cancelled.questions_contact", company=company)
    assert str(html) == f"If you have any questions, please contact {company}"


def test_only_the_product_s_own_test_e_mail_has_words_for_the_product() -> None:
    """Nothing of the product reaches a company's people (B12-22): no sentence of the catalog can name
    the product or its brand but those of the CLI's test e-mail and the footer that only it uses. The
    sentence "Sent by <product> on behalf of <company>" is gone with the last e-mail that said it."""
    assert "footer.sent_for" not in MESSAGES
    naming = {
        key
        for key, texts in MESSAGES.items()
        if placeholders(texts[Language.EN]) & {"product", "brand", "sender"}
    }
    assert naming == {"footer.sent", "test.subject", "test.intro"}
    for key, texts in MESSAGES.items():
        for text in texts.values():
            assert "Mawdoo3" not in text and "موضوع" not in text, key
            assert "on behalf of {company}" not in text and "نيابةً عن {company}" not in text, key


def test_a_window_s_end_is_a_phrase_that_brings_its_own_preposition_in_arabic() -> None:
    """B12-23: «تنتهي صلاحية بطاقتك» is followed by «عند 12:00» on the visit's day and by «يوم … الساعة …»
    on another one, so the Arabic sentence has no «عند» of its own; the English one keeps its "at"."""
    for key in ("invitation.window", "rescheduled.window"):
        assert "وتنتهي صلاحية بطاقتك {end} ({zone})." in MESSAGES[key][Language.AR]
        assert "عند" not in MESSAGES[key][Language.AR]
        assert "Your pass expires at {end} ({zone})." in MESSAGES[key][Language.EN]
    same_day = translate(Language.AR, "invitation.window", start="09:00", end="عند 12:00", zone="بتوقيت عمّان")
    assert same_day == "يمكنك تسجيل الدخول ابتداءً من 09:00، وتنتهي صلاحية بطاقتك عند 12:00 (بتوقيت عمّان)."


def test_a_sentence_ending_with_an_ordinary_value_keeps_its_full_stop() -> None:
    assert translate(Language.EN, "footer.company", company="Other Corp") == "Sent by Other Corp."
    assert translate(Language.AR, "footer.company", company="Other Corp") == "أُرسلت من Other Corp."
    assert translate(Language.EN, "footer.sent", product="Mawdoo3 Visitors") == "Sent by Mawdoo3 Visitors."
    assert translate(Language.AR, "footer.sent", product="زوار موضوع") == "أُرسلت عبر زوار موضوع."
    # Only a value at the very end counts: a full stop inside the sentence stays.
    assert translate(Language.EN, "invitation.invited", host="J. Smith Jr.", company="Acme") == (
        "J. Smith Jr. has invited you to visit Acme."
    )
