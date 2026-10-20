"""E-mail findings of the Phase 11 security and UX reviews (docs/decisions/phase-11-backend.md):

* B11-40: what bounds the e-mail a company's texts can make (a subject's length, how often a variable
  may appear, `{purpose}` not in subjects, what a text renders to, texts saved before a rule);
* B11-41: no RFC 2047 encoded word in a Subject, whichever provider sends it;
* B11-43: the notice of a platform action, in both languages;
* B11-47: a time range in a sentence stays on one line;
* B11-48: the closing paragraph is a paragraph of its own;
* B11-49: a reset link sent by the platform owner says so.
"""

import json
import re
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from pydantic import SecretStr

from app.core.config import Settings
from app.core.field_errors import FIELD_CODE_PARAMS, FieldCode
from app.email.editable import (
    EDITABLE,
    FIELD_MAX_LENGTH,
    MAX_VARIABLE_USES,
    RENDERED_FACTOR,
    check_text,
    default_text,
    render_html,
    render_subject,
    render_text,
    rendered_limit,
    usable_texts,
)
from app.email.formatting import RANGE_DASH, on_one_line
from app.email.headers import (
    ELLIPSIS,
    SUBJECT_MAX_LENGTH,
    cut_short,
    literal_text,
    shorten,
    subject_line,
)
from app.email.i18n import LEFT_TO_RIGHT_VALUES, MESSAGES, translate_html
from app.email.providers.memory import MemoryProvider
from app.email.providers.outbox import OutboxProvider
from app.email.providers.resend import ResendProvider
from app.email.rendering import EmailRenderer
from app.email.service import (
    NO_BRAND_IMAGES,
    SUBJECT_NAME_MIN,
    SUBJECT_SEPARATOR,
    TEST_SUBJECT_PREFIX,
    BrandImageSource,
    EmailService,
    cut_at_its_end,
    join_subjects,
    subject_within,
)
from app.models import EDITABLE_EMAIL_KINDS, Company, EmailKind, Language, TemplateField, User, Visit
from tests.png_support import CompanyLogos, drawn_logo, png_size

AR, EN = Language.AR, Language.EN
START = datetime(2026, 10, 6, 10, 30, tzinfo=UTC)  # 13:30 in Asia/Amman
NB = "\N{NO-BREAK SPACE}"
FSI, LRI, PDI = "\N{FIRST STRONG ISOLATE}", "\N{LEFT-TO-RIGHT ISOLATE}", "\N{POP DIRECTIONAL ISOLATE}"
RLO, PDF = "\N{RIGHT-TO-LEFT OVERRIDE}", "\N{POP DIRECTIONAL FORMATTING}"
ISOLATES = re.compile("[\N{LEFT-TO-RIGHT ISOLATE}-\N{POP DIRECTIONAL ISOLATE}]")
VISIT_KINDS = ("VISITOR_INVITATION", "VISIT_RESCHEDULED", "VISIT_CANCELLED")
ENCODED_WORD = "=?utf-8?q?Free_gift=0D=0ABcc:_victim@evil.test?="


class _Messages:
    def __init__(self) -> None:
        self.rows: list = []

    def add(self, message):
        self.rows.append(message)
        return message


class _Texts:
    def __init__(self, texts) -> None:
        self.texts_by_kind = texts

    def texts(self, company_id, kind):
        return self.texts_by_kind.get(str(kind), {})


def _service(texts=None, *, brand_images: BrandImageSource = NO_BRAND_IMAGES) -> EmailService:
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
        template_texts=_Texts(texts or {}),
        brand_images=brand_images,
    )
    service.messages = _Messages()  # type: ignore[assignment]
    return service


def _company(**changes) -> Company:
    values = {
        "id": uuid.uuid4(),
        "name": "Acme Holding",
        "name_ar": "أكمي القابضة",
        "slug": "acme",
        "timezone": "Asia/Amman",
        "address": "Building 14",
        "notify_host_on_check_in": True,
        "default_language": "en",
    }
    values.update(changes)
    return Company(**values)


def _visit(company: Company, **changes) -> Visit:
    values = {
        "id": uuid.uuid4(),
        "company_id": company.id,
        "visitor_id": uuid.uuid4(),
        "host_id": uuid.uuid4(),
        "visitor_name": "Dana Guest",
        "visitor_company_name": "Globex",
        "host_name": "Omar Khalil",
        "department_name": "Finance",
        "department_name_ar": "المالية",
        "purpose": "Quarterly review",
        "scheduled_start": START,
        "scheduled_end": START + timedelta(hours=1),
        "window_start": START - timedelta(hours=1),
        "window_end": START + timedelta(hours=2),
        "check_in_at": START + timedelta(minutes=5),
    }
    values.update(changes)
    return Visit(**values)


def _user(
    company: Company, name: str = "Amal Haddad", email: str = "amal@acme.example", language=None
) -> User:
    user = User(
        id=uuid.uuid4(),
        company_id=company.id,
        full_name=name,
        email=email,
        preferred_language=language,
        roles=["SYSTEM_ADMIN"],
    )
    user.company = company
    return user


def _queue(service: EmailService, kind: str, company: Company, visit: Visit):
    """The e-mail of `kind` for the visit, as the product queues it."""
    match kind:
        case "VISITOR_INVITATION":
            return service.queue_visitor_invitation(
                visit, "t" * 43, company=company, recipient="dana@example.com", host_email=None
            ).email
        case "VISIT_RESCHEDULED":
            return service.queue_visit_rescheduled(
                visit, company=company, recipient="dana@example.com", host_email=None
            ).email
        case "VISIT_CANCELLED":
            return service.queue_visit_cancelled(
                visit, "Change of plans", company=company, recipient="dana@example.com", host_email=None
            ).email
        case "VISITOR_CALENDAR":
            return service.queue_visitor_calendar(
                visit, company=company, recipient="dana@example.com", host_email=None
            ).email
    host = _user(company, "Omar Khalil", "omar@acme.example", "en")
    if kind.startswith("HOST_VISIT_"):
        return service.queue_host_visit(
            visit, kind=EmailKind(kind), company=company, host=host, reason="Change of plans"
        ).email
    return service.queue_host_arrival(visit, company=company, host=host).email


def _read(text: str) -> str:
    return ISOLATES.sub("", text).replace(NB, " ")


def _field(kind: str, name: str):
    field = EDITABLE[EmailKind(kind)].field(name)
    assert field is not None
    return field


# ---- B11-40 / B11-41: every Subject, finished in one place ----------------------------------------------


def test_a_subject_line_is_one_line_without_controls_or_an_encoded_word() -> None:
    assert subject_line("Hello\r\nBcc: victim@example.com") == "Hello Bcc: victim@example.com"
    assert subject_line(f"Visit{NB}to\N{WORD JOINER} Acme") == "Visit to Acme"  # read and searched as typed
    assert subject_line(ENCODED_WORD) == "= ?utf-8?q?Free_gift=0D=0ABcc:_victim@evil.test?="
    assert subject_line("a=?b=?c") == "a= ?b= ?c" and "=?" not in subject_line("==??=?=?")
    # A direction control never reaches a header: nothing would close it before the other language's half.
    assert subject_line(f"Visit: {RLO}gnp.exe{PDF} | زيارة") == "Visit: gnp.exe | زيارة"
    assert subject_line(f"{FSI}Acme{PDI} \N{RIGHT-TO-LEFT EMBEDDING}x\N{LEFT-TO-RIGHT ISOLATE}y") == "Acme xy"
    # ... and removing one cannot put an encoded word together.
    assert subject_line(f"={RLO}?utf-8?q?x?=") == "= ?utf-8?q?x?="
    for text in ("Your visit to Acme on Tuesday, 6 October 2026", "زيارتك إلى أكمي", "", "= ?x"):
        assert subject_line(text) == text and subject_line(subject_line(text)) == subject_line(text)
    assert literal_text("no word here = ?") == "no word here = ?"


def test_a_subject_is_cut_to_its_limit_with_an_ellipsis() -> None:
    assert SUBJECT_MAX_LENGTH == 250
    long = "Your visit to " + "A" * 400
    cut = subject_line(long)
    assert len(cut) == 250 and cut.endswith(ELLIPSIS) and cut[:-1] == long[:249]
    assert subject_line("x" * 250) == "x" * 250  # exactly at the limit: untouched
    assert subject_line(cut) == cut
    assert shorten("word " * 10, 11) == f"word word{ELLIPSIS}"  # no space before the ellipsis
    assert cut_short("fits", 10) == f"fits{ELLIPSIS}" and shorten("fits", 10) == "fits"
    with pytest.raises(ValueError, match="at least one"):
        shorten("text", 0)


@pytest.mark.parametrize(
    ("text", "limit", "expected"),
    [
        # An Arabic letter keeps its vowel signs, or loses them with it.
        ("قَدَّمَ", 4, f"قَ{ELLIPSIS}"),
        ("ab\N{COMBINING ACUTE ACCENT}cd", 3, f"a{ELLIPSIS}"),
        # A character outside the BMP is one character, never half of one.
        ("ab\N{GRINNING FACE}cd", 4, f"ab\N{GRINNING FACE}{ELLIPSIS}"),
        ("ab\N{GRINNING FACE}cd", 3, f"ab{ELLIPSIS}"),
        # An emoji with its variation selector, a family joined by ZWJ, a skin tone, a flag.
        ("a\N{HEAVY BLACK HEART}\N{VARIATION SELECTOR-16}bcd", 3, f"a{ELLIPSIS}"),
        ("a\N{MAN}\N{ZERO WIDTH JOINER}\N{WOMAN}\N{ZERO WIDTH JOINER}\N{GIRL}z", 4, f"a{ELLIPSIS}"),
        ("a\N{WAVING HAND SIGN}\N{EMOJI MODIFIER FITZPATRICK TYPE-4}bc", 3, f"a{ELLIPSIS}"),
        (
            "\N{REGIONAL INDICATOR SYMBOL LETTER J}\N{REGIONAL INDICATOR SYMBOL LETTER O}"
            "\N{REGIONAL INDICATOR SYMBOL LETTER S}\N{REGIONAL INDICATOR SYMBOL LETTER A}x",
            4,
            f"\N{REGIONAL INDICATOR SYMBOL LETTER J}\N{REGIONAL INDICATOR SYMBOL LETTER O}{ELLIPSIS}",
        ),
        # Text that came through UTF-16 with its pair unjoined: the halves stay together.
        ("ab" + chr(0xD83D) + chr(0xDE00) + "cd", 4, f"ab{ELLIPSIS}"),
    ],
)
def test_a_cut_never_falls_inside_one_character(text: str, limit: int, expected: str) -> None:
    cut = shorten(text, limit)
    assert cut == expected and len(cut) <= limit
    if chr(0xD83D) not in text:
        cut.encode("utf-8")
        assert cut.encode("utf-16", "surrogatepass").decode("utf-16") == cut  # no lone surrogate


def test_each_language_keeps_its_share_of_a_bilingual_subject() -> None:
    room = SUBJECT_MAX_LENGTH - len(SUBJECT_SEPARATOR)
    short, long = "Your visit to Acme", "L" * 400

    def joined_texts(first: str, second: str) -> str:
        return join_subjects(cut_at_its_end(first), cut_at_its_end(second))

    assert joined_texts(short, "زيارتك إلى أكمي") == f"{short} | زيارتك إلى أكمي"
    # One long half: the short one stays whole, the long one takes the rest.
    first, second = joined_texts(long, short).split(SUBJECT_SEPARATOR)
    assert second == short and len(first) == room - len(short) and first.endswith(ELLIPSIS)
    first, second = joined_texts(short, long).split(SUBJECT_SEPARATOR)
    assert first == short and len(second) == room - len(short) and second.endswith(ELLIPSIS)
    # Two long halves: neither pushes the other out.
    joined = joined_texts(long, "ع" * 400)
    first, second = joined.split(SUBJECT_SEPARATOR)
    assert len(joined) == SUBJECT_MAX_LENGTH and len(first) == room // 2 and len(second) == room - room // 2
    assert first.endswith(ELLIPSIS) and second.endswith(ELLIPSIS)
    assert subject_line(joined) == joined  # the renderer's own pass changes nothing
    # A smaller room (what a test e-mail's prefix leaves) is shared the same way.
    smaller = join_subjects(cut_at_its_end(long), cut_at_its_end(long), room=101)
    assert [len(half) for half in smaller.split(SUBJECT_SEPARATOR)] == [49, 49]


def test_the_product_s_own_subject_is_bounded_too() -> None:
    """A company name has up to 200 characters in each language: the two halves of the product's own
    bilingual subject came to 460 and more."""
    company = _company(name="N" * 200, name_ar="ش" * 200)
    for kind in (*VISIT_KINDS, "HOST_ARRIVAL"):
        email = _queue(_service(), kind, company, _visit(company, visitor_name="V" * 200))
        assert len(email.subject) <= SUBJECT_MAX_LENGTH, kind
    invitation = _queue(_service(), "VISITOR_INVITATION", company, _visit(company))
    english, arabic = invitation.subject.split(SUBJECT_SEPARATOR)
    assert english.startswith("Your visit to NNN") and arabic.startswith("زيارتك إلى ششش")
    assert len(invitation.subject) == SUBJECT_MAX_LENGTH


# ---- B12-24: a long name gives way inside the subject, the date stays --------------------------------------

LONG_NAME = "International Company for Advanced Technological Solutions and Integrated Digital Services"
LONG_NAME_AR = "الشركة العالمية للحلول التقنية المتقدمة والخدمات الرقمية المتكاملة المحدودة"


def test_the_reviewer_s_long_company_name_no_longer_costs_the_subject_its_date() -> None:
    """The review's company: 90 and 75 characters. Its invitation's subject ended "… on Wednesday, 14
    Octo…". Now the name is shortened where it stands and each language's half is a whole sentence."""
    company = _company(name=LONG_NAME, name_ar=LONG_NAME_AR, default_language="ar")
    subject = _queue(_service(), "VISITOR_INVITATION", company, _visit(company)).subject
    arabic, english = subject.split(SUBJECT_SEPARATOR)
    assert arabic == f"زيارتك إلى {LONG_NAME_AR} يوم الثلاثاء، 6 تشرين الأول 2026"  # it fits: untouched
    assert english == (
        "Your visit to International Company for Advanced Technological Solutions and Integrated Digital "
        f"Serv{ELLIPSIS} on Tuesday, 6 October 2026"
    )
    assert len(subject) == SUBJECT_MAX_LENGTH and subject.count(ELLIPSIS) == 1
    # The other kinds name no date and fit as they are.
    for kind in ("VISIT_RESCHEDULED", "VISIT_CANCELLED"):
        assert ELLIPSIS not in _queue(_service(), kind, company, _visit(company)).subject


def test_both_halves_of_a_subject_stay_whole_sentences_whatever_the_company_is_called() -> None:
    """Names of 200 characters in both languages: each half keeps its own share of the room, gives up
    as much of the name as it must, and still ends with its date."""
    company = _company(name="N" * 200, name_ar="ش" * 200)
    subject = _queue(_service(), "VISITOR_INVITATION", company, _visit(company)).subject
    english, arabic = subject.split(SUBJECT_SEPARATOR)
    room = SUBJECT_MAX_LENGTH - len(SUBJECT_SEPARATOR)
    assert len(english) == room // 2 and len(arabic) == room - room // 2
    assert re.fullmatch(rf"Your visit to N+{ELLIPSIS} on Tuesday, 6 October 2026", english)
    assert re.fullmatch(rf"زيارتك إلى ش+{ELLIPSIS} يوم الثلاثاء، 6 تشرين الأول 2026", arabic)
    for kind in ("VISIT_RESCHEDULED", "VISIT_CANCELLED"):
        english, arabic = _queue(_service(), kind, company, _visit(company)).subject.split(SUBJECT_SEPARATOR)
        assert english.endswith(
            f"{ELLIPSIS} has been {'rescheduled' if 'RESCHEDULED' in kind else 'cancelled'}"
        )
        assert arabic.endswith(ELLIPSIS) and len(english) + len(arabic) == room  # Arabic ends with the name


def test_a_company_s_own_subject_gives_way_by_the_name_too() -> None:
    """A subject the company wrote is shortened the same way, wherever it put the name and however
    often (the excess is shared by the name's places)."""
    company = _company(name="N" * 200, name_ar="ش" * 200)
    texts = {
        "VISITOR_INVITATION": {
            EN: {"subject": "{company}: your visit on {date} ({company})"},
            AR: {"subject": "دعوة من {company} يوم {date}"},
        }
    }
    subject = _queue(_service(texts), "VISITOR_INVITATION", company, _visit(company)).subject
    english, arabic = subject.split(SUBJECT_SEPARATOR)
    assert re.fullmatch(rf"(N+{ELLIPSIS}): your visit on Tuesday, 6 October 2026 \(\1\)", english)
    assert re.fullmatch(rf"دعوة من ش+{ELLIPSIS} يوم الثلاثاء، 6 تشرين الأول 2026", arabic)
    assert SUBJECT_MAX_LENGTH - 2 <= len(subject) <= SUBJECT_MAX_LENGTH


def test_a_subject_is_shortened_by_the_company_s_name_first() -> None:
    def wording(name: str) -> str:
        return f"Your visit to {name} on Monday, 5 October 2026"

    whole = wording("Acme Holding")
    assert (
        subject_within(wording, "Acme Holding", 250) == whole == subject_within(wording, "Acme Holding", 52)
    )
    # One character too long: the name gives up two (one of them makes room for the ellipsis).
    name = "Acme Holding International Group"
    assert subject_within(wording, name, len(wording(name)) - 1) == wording(
        f"Acme Holding International Gro{ELLIPSIS}"
    )
    assert (
        subject_within(wording, name, 52) == f"Your visit to Acme Holdin{ELLIPSIS} on Monday, 5 October 2026"
    )
    # No space is left before the ellipsis, and a cut never falls inside a character: an Arabic letter
    # keeps its vowel signs.
    assert subject_within(wording, "Acme Holding International", 54) == wording(f"Acme Holding{ELLIPSIS}")
    vowelled = "قَدَّمَتْ الشَّرِكَةُ العَالَمِيَّةُ"
    assert subject_within(lambda name: f"زيارتك إلى {name} غدًا", vowelled, 44) == (
        f"زيارتك إلى قَدَّمَتْ الشَّرِكَةُ العَا{ELLIPSIS} غدًا"
    )
    # A name keeps at least twelve characters, the ellipsis among them. Where that is not enough, the
    # subject is cut at its end, as every subject was.
    assert SUBJECT_NAME_MIN == 12
    assert subject_within(wording, name, 51) == shorten(wording(name), 51) == wording(name)[:49] + ELLIPSIS

    # A subject that names the company twice shares the excess between the two places: six characters
    # too long, each gives up three (and one more for its ellipsis), not six.
    def twice(name: str) -> str:
        return f"{name}: your visit ({name})"

    assert len(twice(name)) == 79
    assert subject_within(twice, name, 73) == twice(f"Acme Holding International G{ELLIPSIS}")
    assert len(subject_within(twice, name, 73)) == 73
    assert subject_within(twice, name, 71) == twice(f"Acme Holding International{ELLIPSIS}")
    # Another value is the long one, or the subject does not name the company: cut at the end.
    assert subject_within(lambda _name: "V" * 300, "Acme Holding", 100) == "V" * 99 + ELLIPSIS
    assert subject_within(wording, "", 20) == shorten(wording(""), 20)
    # What the name is in a subject is what is measured: one line, no direction controls.
    hostile = f"Acme\r\n{RLO}Holding International Group"
    assert (
        subject_within(wording, hostile, 60)
        == f"Your visit to Acme Holding Intern{ELLIPSIS} on Monday, 5 October 2026"
    )


def test_a_name_that_ends_a_sentence_still_fits_once_it_is_shortened() -> None:
    """A name's own full stop replaces the sentence's ("… ACME Inc."); the shortened name has none, so
    the sentence's own comes back and the subject is one character longer than the arithmetic says."""
    company = _company(name="A" * 150 + " Inc.", name_ar="ش" * 150)
    texts = {"VISIT_CANCELLED": {EN: {"subject": "No visit to {company}."}, AR: {"subject": "{company}."}}}
    subject = _queue(_service(texts), "VISIT_CANCELLED", company, _visit(company)).subject
    english, arabic = subject.split(SUBJECT_SEPARATOR)
    assert len(subject) <= SUBJECT_MAX_LENGTH
    assert re.fullmatch(rf"No visit to A+{ELLIPSIS}", english) and re.fullmatch(rf"ش+{ELLIPSIS}", arabic)


def test_the_reviewer_s_subject_of_fifteen_thousand_characters() -> None:
    """`{company}` and fifteen `{purpose}` with a 500-character purpose rendered a 15,071-character
    subject. That text can no longer be saved; if it is in the database from before, it is not used."""
    text = "{company}" + "{purpose}" * 15
    subject = _field("VISITOR_INVITATION", "subject")
    problem = check_text(subject, EDITABLE[EmailKind.VISITOR_INVITATION], text)
    assert problem is not None and problem.code == FieldCode.PLACEHOLDER_NOT_ALLOWED
    company = _company()
    saved = {"VISITOR_INVITATION": {EN: {"subject": text, "intro": "{purpose}" * 100}}}
    email = _queue(_service(saved), "VISITOR_INVITATION", company, _visit(company, purpose="P" * 500))
    # The product's subject and intro instead of the saved ones.
    assert email.subject.startswith("Your visit to Acme Holding on Tuesday, 6 October 2026 | ")
    assert len(email.subject) < 120 and "PPPP" not in email.subject
    assert "Omar Khalil has invited you to visit Acme Holding." in email.text
    assert email.html.count("P" * 500) == 2 and email.text.count("P" * 500) == 2  # the details grid only


# ---- B11-41: every provider gets the same subject ---------------------------------------------------------


@pytest.mark.parametrize("where", ["a company's own subject", "the company's name", "the visitor's name"])
def test_no_provider_is_handed_an_encoded_word(where: str, tmp_path: Path) -> None:
    """The finding: only the SMTP provider broke up `=?`. Resend got the subject as typed, and so did the
    development outbox and the e-mail log."""
    texts = {}
    company = _company()
    visit = _visit(company)
    kind = "VISITOR_INVITATION"
    if where == "a company's own subject":
        texts = {
            kind: {EN: {"subject": ENCODED_WORD + " {company}"}, AR: {"subject": ENCODED_WORD + "{company}"}}
        }
    elif where == "the company's name":
        company = _company(name=ENCODED_WORD, name_ar=None)
        visit = _visit(company)
    else:
        kind = "HOST_ARRIVAL"
        visit = _visit(company, visitor_name=ENCODED_WORD)
    service = _service(texts)
    email = _queue(service, kind, company, visit)
    assert "=?" not in email.subject and "= ?utf-8?q?Free_gift" in email.subject
    # What Resend is sent, what the outbox writes, what the memory provider keeps, what the log stores.
    assert "=?" not in ResendProvider.payload(email)["subject"]
    OutboxProvider(tmp_path).send(email)
    assert "=?" not in json.loads((tmp_path / f"{email.message_id}.json").read_text("utf-8"))["subject"]
    memory = MemoryProvider()
    memory.send(email)
    assert memory.sent[0].subject == email.subject
    assert all("=?" not in row.subject for row in service.messages.rows)  # type: ignore[attr-defined]
    assert ResendProvider(SecretStr("re_key")).name == "resend"


def _test_subject(company: Company, prefix: str, kind: str = "VISITOR_INVITATION") -> str:
    """The subject of a test e-mail of the company's texts: built with its prefix (B12-24)."""
    service, visit = _service(), _visit(company)
    match kind:
        case "VISITOR_INVITATION":
            prepared = service.prepare_visitor_invitation(
                visit, "https://vms.test/pass#x", company=company, host_email=None, subject_prefix=prefix
            )
        case "VISIT_RESCHEDULED":
            prepared = service.prepare_visit_rescheduled(
                visit, company=company, host_email=None, subject_prefix=prefix
            )
        case "VISIT_CANCELLED":
            prepared = service.prepare_visit_cancelled(
                visit, None, company=company, host_email=None, subject_prefix=prefix
            )
        case _:
            prepared = service.prepare_host_arrival(
                visit, company=company, host_name="Omar Khalil", host_language="en", subject_prefix=prefix
            )
    job = service.queue_prepared(prepared, company_id=company.id, to="a@example.com")
    assert job.email.subject == prepared.rendered.subject
    assert f"<title>{job.email.subject}</title>" in job.email.html  # the document is titled as it is sent
    return job.email.subject


def test_a_test_e_mail_s_prefix_is_inside_the_limit_and_literal() -> None:
    company = _company(name="N" * 200, name_ar="ش" * 200)
    subject = _test_subject(company, "[Test] ")
    assert subject.startswith("[Test] Your visit to NNN") and len(subject) == SUBJECT_MAX_LENGTH
    hostile = _test_subject(company, "=?x?q?=41?= ")
    assert hostile.startswith("= ?x?q?=41?= Your visit") and len(hostile) <= SUBJECT_MAX_LENGTH
    assert (
        _test_subject(_company(), "")
        == _queue(_service(), "VISITOR_INVITATION", _company(), _visit(_company())).subject
    )


@pytest.mark.parametrize("language", [AR, EN], ids=str)
def test_a_test_e_mail_s_prefix_costs_the_name_a_little_and_never_the_date(language: Language) -> None:
    """The prefix used to be put before a subject that already filled its room: the end of the second
    half, its date, was cut off for it. The subject is now built for the room the prefix leaves."""
    prefix = TEST_SUBJECT_PREFIX[language]
    assert TEST_SUBJECT_PREFIX == {AR: "[رسالة تجريبية] ", EN: "[Test] "}
    company = _company(name=LONG_NAME, name_ar=LONG_NAME_AR, default_language=language.value)
    subject = _test_subject(company, prefix)
    assert subject.startswith(prefix) and len(subject) <= SUBJECT_MAX_LENGTH
    halves = subject.removeprefix(prefix).split(SUBJECT_SEPARATOR)
    english, arabic = halves if language == EN else reversed(halves)
    assert english.endswith(" on Tuesday, 6 October 2026") and arabic.endswith(
        " يوم الثلاثاء، 6 تشرين الأول 2026"
    )
    assert english.startswith("Your visit to International Company for Advanced")
    # Without the prefix the same subject has that much more of the name.
    plain = _queue(_service(), "VISITOR_INVITATION", company, _visit(company)).subject
    assert len(plain) == SUBJECT_MAX_LENGTH and len(subject) in (SUBJECT_MAX_LENGTH - 1, SUBJECT_MAX_LENGTH)
    # Every editable kind takes its prefix, a host's arrival notice (one language) included.
    for kind in ("VISIT_RESCHEDULED", "VISIT_CANCELLED", "HOST_ARRIVAL"):
        prefixed = _test_subject(_company(default_language=language.value), prefix, kind)
        assert prefixed.startswith(prefix) and ELLIPSIS not in prefixed
    assert (
        _test_subject(_company(), "[Test] ", "HOST_ARRIVAL") == "[Test] Your visitor Dana Guest has arrived"
    )


# ---- B11-40: the rules of a text ---------------------------------------------------------------------------


def test_the_new_field_codes_carry_their_parameters() -> None:
    assert FIELD_CODE_PARAMS[FieldCode.PLACEHOLDER_NOT_ALLOWED] == ("name",)
    assert FIELD_CODE_PARAMS[FieldCode.PLACEHOLDER_REPEATED] == ("max", "name")
    assert MAX_VARIABLE_USES == 3 and RENDERED_FACTOR == 2


@pytest.mark.parametrize("kind", EDITABLE_EMAIL_KINDS, ids=str)
def test_a_purpose_is_not_a_variable_of_a_subject(kind: EmailKind) -> None:
    spec = EDITABLE[kind]
    subject = spec.field(TemplateField.SUBJECT)
    assert subject is not None and subject.forbidden == ("purpose",) and "purpose" in spec.variables
    required = "{" + subject.required[0] + "}"
    problem = check_text(subject, spec, f"{required}: {{purpose}}")
    assert problem is not None
    assert problem.detail() == {"code": "placeholder_not_allowed", "params": {"name": "purpose"}}
    assert problem.message == "{purpose} cannot be used in this text."
    assert check_text(subject, spec, f"{required} on {{date}}") is None
    # Every other text of the kind may name it.
    for field in spec.fields:
        if field.name != TemplateField.SUBJECT:
            assert (
                field.forbidden == ()
                and check_text(field, spec, "About {purpose}"[: field.max_length]) is None
            )


def test_a_variable_appears_at_most_three_times_in_one_text() -> None:
    spec = EDITABLE[EmailKind.VISITOR_INVITATION]
    intro = _field("VISITOR_INVITATION", "intro")
    assert check_text(intro, spec, "{purpose} {purpose} {purpose} and {visitor_name}") is None
    problem = check_text(intro, spec, "{company} {purpose}{purpose} {purpose} {purpose}")
    assert problem is not None
    assert problem.detail() == {"code": "placeholder_repeated", "params": {"max": 3, "name": "purpose"}}
    assert problem.message == "Use {purpose} at most 3 times in this text."
    # The first problem in the order of the checks: an unknown variable, then one that is not allowed here,
    # then a repeated one, then a missing one.
    subject = _field("VISITOR_INVITATION", "subject")
    codes = [
        check_text(subject, spec, text).code  # type: ignore[union-attr]
        for text in (
            "{nope} {purpose} {date}{date}{date}{date}",
            "{purpose} {date}{date}{date}{date}",
            "{date}{date}{date}{date}",
            "{date}",
        )
    ]
    assert codes == [
        FieldCode.UNKNOWN_PLACEHOLDER,
        FieldCode.PLACEHOLDER_NOT_ALLOWED,
        FieldCode.PLACEHOLDER_REPEATED,
        FieldCode.PLACEHOLDER_REQUIRED,
    ]


@pytest.mark.parametrize("kind", EDITABLE_EMAIL_KINDS, ids=str)
def test_the_product_s_own_texts_pass_the_new_rules(kind: EmailKind) -> None:
    spec = EDITABLE[kind]
    for field in spec.fields:
        for language in (AR, EN):
            text = default_text(field, language)
            assert not text or check_text(field, spec, text) is None, (kind, field.name, language)


def test_a_saved_text_is_used_only_while_it_passes_the_checks() -> None:
    saved = {
        EN: {
            "subject": "{company}: {purpose}",  # saved before `{purpose}` left the subjects
            "heading": "Welcome to {company}",
            "intro": "{purpose}" * 4,  # saved before the repeat limit
            "closing": "<b>bold</b>",  # never passed
            "nonsense": "not a field",
            "footer_note": "",
        },
        AR: {"heading": "أهلًا بك في {company}", "button": "x" * 41},
    }
    assert usable_texts("VISITOR_INVITATION", saved) == {
        EN: {"heading": "Welcome to {company}"},
        AR: {"heading": "أهلًا بك في {company}"},
    }
    assert usable_texts(EmailKind.VISIT_RESCHEDULED, {EN: {"button": "Open", "heading": "Moved"}}) == {
        EN: {"heading": "Moved"}
    }
    assert usable_texts("PASSWORD_RESET", saved) == {} and usable_texts("NOT_A_KIND", saved) == {}
    assert usable_texts("HOST_ARRIVAL", {}) == {}


def test_a_text_renders_to_twice_its_own_limit_at_most() -> None:
    assert {field.value: limit for field, limit in FIELD_MAX_LENGTH.items()} == {
        "subject": 150,
        "heading": 150,
        "greeting": 150,
        "intro": 1000,
        "button": 40,
        "closing": 1000,
        "footer_note": 300,
    }
    assert rendered_limit("heading") == rendered_limit(TemplateField.HEADING) == 300
    values = {"company": "C" * 200, "visitor_name": "هند " * 50, "date": "Tuesday, 6 October 2026"}
    text = "Welcome {visitor_name} to {company} on {date}. See you at {company}!"
    assert len(render_text(text, values, EN)) > 300  # unbounded: the values decide
    plain = render_text(text, values, EN, limit=300)
    visible = ISOLATES.sub("", plain)
    assert len(visible) == 300 and visible.endswith(ELLIPSIS)
    # The cut fell inside the first company's value: the name before it is whole, inside its isolates.
    assert (
        plain.startswith(f"Welcome {FSI}{'هند ' * 50}{PDI} to CCC")
        and plain.count(FSI) == plain.count(PDI) == 1
    )
    html = str(render_html(text, values, EN, limit=300))
    assert html.count("<span") == html.count("</span>") == 1 and html.endswith(f"C{ELLIPSIS}")
    # A cut inside an isolated value stays inside its markup.
    html = str(render_html("{visitor_name} and more", values, EN, limit=20))
    assert html == f'<span dir="rtl">{("هند " * 50)[:19].rstrip()}{ELLIPSIS}</span>'
    plain = render_text("{visitor_name} and more", values, EN, limit=20)
    assert plain.startswith(FSI) and plain.endswith(f"{ELLIPSIS}{PDI}")
    # A text that fits is not touched, and no limit means none.
    assert render_text("Hi {company}", {"company": "Acme"}, EN, limit=12) == "Hi Acme"
    assert render_text("Hi {company}!", {"company": "Acme"}, EN, limit=7) == f"Hi Acm{ELLIPSIS}"
    assert render_text("abcdefgh", {}, EN, limit=5) == f"abcd{ELLIPSIS}"
    assert render_subject("{company}", {"company": "C" * 400}) == "C" * 249 + ELLIPSIS


def _largest_texts(kind: EmailKind) -> dict[Language, dict[str, str]]:
    """For every field of the kind, a text that `check_text` accepts and that renders as long as it can:
    every allowed variable as often as allowed (the longest values first), padded to the field's limit."""
    spec = EDITABLE[kind]
    longest_first = ("purpose", "visitor_name", "company", "host_name", "visitor_company", "department")
    texts: dict[str, str] = {}
    for field in spec.fields:
        names = [name for name in longest_first if name in spec.variables and name not in field.forbidden]
        names += [name for name in field.required if name not in names]
        text = "".join("{" + name + "}" for name in field.required)
        for name in names:
            uses = MAX_VARIABLE_USES - (1 if name in field.required else 0)
            for _ in range(uses):
                if len(text) + len(name) + 2 <= field.max_length:
                    text += "{" + name + "}"
        text += "&" * (field.max_length - len(text))
        assert len(text) == field.max_length and check_text(field, spec, text) is None, (kind, field.name)
        texts[field.name.value] = text
    return {EN: texts, AR: dict(texts)}


# Gmail clips a message whose HTML passes about 102 KB (the rest behind "[Message clipped]", the pass's
# QR code and the footer with it). The worst e-mail stays below 95 KiB: room for what a later round adds
# (B13-8).
HTML_MAX_BYTES = 95 * 1024
# The two heaviest headers (B13-8, B13-12): the company's name stands twice in each. A wordmark for light
# surfaces (its text alternative) with a mark for dark ones (the name beside it), and an emblem for light
# surfaces (the name beside it) with a wordmark for dark ones (its text alternative).
HEAVIEST_HEADERS = {"wordmark and dark mark": ("navy", "mark"), "emblem and dark wordmark": ("mark", "gold")}


@pytest.mark.parametrize("header", HEAVIEST_HEADERS)
@pytest.mark.parametrize("lead", [AR, EN])
@pytest.mark.parametrize("kind", [*EDITABLE_EMAIL_KINDS, EmailKind.VISITOR_CALENDAR], ids=str)
def test_the_largest_e_mail_a_company_s_texts_can_make(kind: EmailKind, lead: Language, header: str) -> None:
    """The reviewer measured 329 KiB of HTML and 285 KiB of text from one field. With every field of a
    kind at its worst (the longest texts that can be saved, every value at the longest the API stores,
    made of the character that grows most when escaped), an e-mail now stays below a third of that, and
    most of what is left is the product's own layout around those values.

    Since Phase 13 (B13-8) with the header at its heaviest too (`HEAVIEST_HEADERS`) and both designs'
    style sheets, below 95 KiB. Measured without logos this guard missed that the worst invitation had
    reached 101,655 bytes, a few hundred under Gmail's clip. Since Phase 14 the host's e-mails of a visit
    and the visitor's calendar invitation too (which takes the invitation's texts, B14-10); Gmail counts
    the HTML part, not the calendar parts beside it (B14-8)."""
    worst = "&"  # five characters in HTML
    company = _company(name=worst * 200, name_ar=worst * 200, address=None, default_language=lead)
    visit = _visit(
        company,
        visitor_name=worst * 200,
        visitor_company_name=worst * 200,
        host_name=worst * 200,
        department_name=worst * 120,
        department_name_ar=worst * 120,
        purpose=worst * 500,
    )
    light, dark = (drawn_logo(name) for name in HEAVIEST_HEADERS[header])
    logos = CompanyLogos(light, *png_size(light), dark=dark)
    texts_of = EmailKind.VISITOR_INVITATION if kind == EmailKind.VISITOR_CALENDAR else kind
    email = _queue(
        _service({texts_of.value: _largest_texts(texts_of)}, brand_images=logos), kind.value, company, visit
    )
    plain = _queue(_service(brand_images=logos), kind.value, company, visit)
    top = email.html[email.html.index('class="vbr"') : email.html.index("<h1")]
    assert top.count("&amp;" * 200) == 2 and 'class="vdo"' in top  # the name twice
    html_size, text_size = len(email.html.encode("utf-8")), len(email.text.encode("utf-8"))
    assert len(email.subject) <= SUBJECT_MAX_LENGTH
    # What the texts add to the product's own e-mail with the same values: the rendered limit of every
    # field, in both languages, at the worst escaping, and nothing that a value's length can move.
    rendered = sum(
        RENDERED_FACTOR * field.max_length for field in EDITABLE[texts_of].fields if field.name != "subject"
    )
    assert text_size - len(plain.text.encode("utf-8")) <= 2 * rendered
    assert html_size - len(plain.html.encode("utf-8")) <= 2 * rendered * len("&amp;") * 2  # the button twice
    assert html_size <= HTML_MAX_BYTES and text_size < 16 * 1024, (kind, html_size, text_size)


# ---- B11-47: a time range in a sentence ----------------------------------------------------------------


def test_a_value_that_holds_a_time_range_stays_on_one_line_in_html() -> None:
    span = f"13:30{RANGE_DASH}14:30"
    assert on_one_line(span) == f'<span style="white-space:nowrap;">13:30{NB}\N{EN DASH}{NB}14:30</span>'
    assert on_one_line(f"22:42{RANGE_DASH}00:42 the next day").startswith(
        '<span style="white-space:nowrap;">22:42'
    )
    # Nothing else is wrapped, and everything is escaped.
    assert (
        on_one_line("13:35") == "13:35"
        and on_one_line("Tuesday, 6 October 2026") == "Tuesday, 6 October 2026"
    )
    assert on_one_line("a < b & c") == "a &lt; b &amp; c"
    assert on_one_line(f"<i>{RANGE_DASH}</i>") == (
        f'<span style="white-space:nowrap;">&lt;i&gt;{RANGE_DASH}&lt;/i&gt;</span>'
    )


@pytest.mark.parametrize("language", [AR, EN])
@pytest.mark.parametrize("kind", VISIT_KINDS)
def test_a_time_range_in_a_company_s_text_does_not_break_at_its_dash(kind: str, language: Language) -> None:
    """The finding: the range broke after its dash, the end time alone on the next line. A line may break
    after an en dash although a no-break
    space follows it, so the range's own no-break spaces did not hold it together."""
    sentence = {AR: "موعدك يوم {date} الساعة {time}.", EN: "We expect you on {date} at {time}."}[language]
    texts = {kind: {language: {"intro": sentence, "closing": sentence}}}
    company = _company(default_language=language.value)
    email = _queue(_service(texts), kind, company, _visit(company))
    together = f'<span style="white-space:nowrap;">13:30{RANGE_DASH}14:30</span>.'
    date = {AR: f"الثلاثاء، 6{NB}تشرين{NB}الأول{NB}2026", EN: "Tuesday, 6 October 2026"}[language]
    before = {AR: f"موعدك يوم {date} الساعة ", EN: f"We expect you on {date} at "}[language]
    assert email.html.count(before + together) == 2  # the intro and the closing
    # Plain text has no markup: the range keeps its no-break spaces.
    assert email.text.count(f"13:30{RANGE_DASH}14:30.") == 2


def test_the_product_s_own_sentences_keep_a_range_together_the_same_way() -> None:
    html = translate_html(EN, "rescheduled.preheader", date="Tuesday", time=f"10:00{RANGE_DASH}11:00")
    assert html == f'New time: Tuesday, <span style="white-space:nowrap;">10:00{RANGE_DASH}11:00</span>. ' + (
        "Your existing QR code remains valid."
    )
    # A single time, a date and a zone are inserted as they were.
    assert (
        translate_html(EN, "arrival.preheader", visitor="Dana", time="10:03") == "Dana checked in at 10:03."
    )
    assert "nowrap" not in translate_html(AR, "changed.preheader.reset", date=f"6{NB}تشرين", time="10:03")


def test_a_host_arrival_s_time_is_a_moment_and_needs_no_wrapping() -> None:
    company = _company()
    texts = {"HOST_ARRIVAL": {EN: {"intro": "{visitor_name} arrived at {time} on {date}."}}}
    email = _queue(_service(texts), "HOST_ARRIVAL", company, _visit(company))
    assert "Dana Guest arrived at 13:35 on Tuesday, 6 October 2026." in email.html


# ---- B11-48: the closing paragraph -----------------------------------------------------------------------


@pytest.mark.parametrize("lead", ["ar", "en"])
@pytest.mark.parametrize("kind", [*VISIT_KINDS, "HOST_ARRIVAL"])
def test_the_closing_is_a_paragraph_of_its_own_in_the_text_part(kind: str, lead: str) -> None:
    """The finding: in the plain-text part the closing followed the paragraph before it without a blank
    line (in two kinds on the very same line)."""
    closing = {EN: "Free parking at gate 2.\nSee you soon.", AR: "مواقف مجانية عند البوابة 2."}
    texts = {kind: {language: {"closing": text} for language, text in closing.items()}}
    company = _company(default_language=lead)
    with_closing = _read(_queue(_service(texts), kind, company, _visit(company)).text)
    without = _read(_queue(_service(), kind, company, _visit(company)).text)
    for text in closing.values():
        position = with_closing.index(text)
        assert with_closing[position - 2 : position] == "\n\n", (kind, text)  # a blank line before it
        assert with_closing[position - 3] != "\n"  # exactly one
        after = with_closing[position + len(text) :]
        assert after.startswith("\n\n"), (kind, text)  # and one after it
    # The paragraph before it ends its own line.
    assert "." + closing[EN] not in with_closing and "." + closing[AR] not in with_closing
    # Nothing else moved: without a closing the text is what it was.
    removed = with_closing
    for text in closing.values():
        removed = removed.replace("\n\n" + text, "")
    assert removed == without


@pytest.mark.parametrize("kind", ["VISIT_RESCHEDULED", "VISIT_CANCELLED"])
def test_the_closing_has_space_above_it_in_html(kind: str) -> None:
    """In these two kinds it follows the questions line, which has no space below it."""
    company = _company()
    email = _queue(
        _service({kind: {EN: {"closing": "Free parking at gate 2."}}}), kind, company, _visit(company)
    )
    assert '<p style="margin:16px 0 16px 0;">Free parking at gate 2.</p>' in email.html


# ---- B11-49: a reset link that the platform owner sent -------------------------------------------------


@pytest.mark.parametrize("language", ["ar", "en"])
def test_a_reset_link_from_the_platform_owner_says_so(language: str) -> None:
    company = _company(default_language=language)
    user = _user(company)
    own = _service().queue_password_reset(user, "T" * 43).email
    sent = _service().queue_password_reset(user, "T" * 43, sent_by_platform_owner=True).email
    for part in (_plain(own.html), _read(own.text)):
        assert "We received a request to reset the password" in part and "If you did not request this" in part
        assert "تلقّينا طلبًا" in part and "إن لم تطلب ذلك" in part
        assert "platform owner" not in part and "مالك المنصة" not in part
    for part in (_plain(sent.html), _read(sent.text)):
        # The reader asked for nothing: no "we received a request", no "if you did not request this".
        assert "We received a request" not in part and "did not request" not in part
        assert "تلقّينا طلبًا" not in part and "لم تطلب" not in part
        assert (
            "The platform owner sent you a link to set a new password for your Acme Holding account." in part
        )
        assert "أرسل إليك مالك المنصة رابطًا لتعيين كلمة مرور جديدة لحسابك في أكمي القابضة." in part
        assert "If you do not need a new password, ignore this email. Your password will not change." in part
        assert "إن لم تكن بحاجة إلى كلمة مرور جديدة، فتجاهل هذه الرسالة، ولن تتغيّر كلمة مرورك." in part
        # The usual expiry line, the same link.
        assert "This link expires in 30 minutes and can be used once." in part
        assert "تنتهي صلاحية هذا الرابط خلال 30 دقيقة، ويمكن استخدامه مرة واحدة." in part
    assert sent.reset_url == own.reset_url == "https://vms.test/reset-password?c=acme#token=" + "T" * 43
    assert sent.html.count(f'href="{sent.reset_url}"') == 2 and sent.text.count(sent.reset_url) == 2
    assert "Open the link below to choose a new password:" in sent.text
    assert (sent.subject, sent.kind) == (own.subject, EmailKind.PASSWORD_RESET)
    # The same layout: only the two sentences differ.
    assert len(sent.html.split("<p")) == len(own.html.split("<p"))


# ---- B11-43: the notice of a platform action ---------------------------------------------------------------


SUBJECTS = {
    ("admin_added", "en"): "A new administrator was added to Acme Holding",
    ("admin_added", "ar"): "أُضيف مدير نظام جديد إلى أكمي القابضة",
    ("reset_sent", "en"): "A password-reset link was sent to an administrator of Acme Holding",
    ("reset_sent", "ar"): "أُرسل رابط لإعادة تعيين كلمة المرور إلى أحد مديري النظام في أكمي القابضة",
}
BODIES = {
    ("admin_added", "en"): "The platform owner added a new administrator account to Acme Holding on "
    "Tuesday, 6 October 2026 at 13:30 (Amman time, UTC+3).",
    (
        "admin_added",
        "ar",
    ): "أضاف مالك المنصة حسابًا جديدًا لمدير نظام في أكمي القابضة يوم الثلاثاء، 6 تشرين الأول "
    "2026 الساعة 13:30 (بتوقيت عمّان، UTC+3).",
    ("reset_sent", "en"): "The platform owner sent a password-reset link to an administrator of Acme Holding "
    "on Tuesday, 6 October 2026 at 13:30 (Amman time, UTC+3).",
    (
        "reset_sent",
        "ar",
    ): "أرسل مالك المنصة رابطًا لإعادة تعيين كلمة المرور إلى أحد مديري النظام في أكمي القابضة "
    "يوم الثلاثاء، 6 تشرين الأول 2026 الساعة 13:30 (بتوقيت عمّان، UTC+3).",
}


def _plain(html: str) -> str:
    spans = re.sub(r'<span dir="(?:ltr|rtl)"[^>]*>([^<]*)</span>', r"\1", html)
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", spans)).replace(NB, " ")


@pytest.mark.parametrize("action", ["admin_added", "reset_sent"])
@pytest.mark.parametrize("language", ["ar", "en"])
def test_the_notice_of_a_platform_action(action: str, language: str) -> None:
    company = _company(default_language="en" if language == "ar" else "ar")  # the recipient's choice leads
    recipient = _user(company, "Amal Haddad", "amal@acme.example", language)
    about = _user(company, "Nadia Saleh", "nadia@acme.example")
    service = _service()
    job = service.queue_platform_notice(recipient, action=action, about=about, when=START)  # type: ignore[arg-type]
    email = job.email
    assert (email.kind, email.to) == (EmailKind.PLATFORM_ACTION_NOTICE, "amal@acme.example")
    assert email.subject == SUBJECTS[action, language]  # a staff subject: the recipient's language only
    assert f'<html lang="{language}" dir="{"rtl" if language == "ar" else "ltr"}"' in email.html
    [row] = service.messages.rows  # type: ignore[attr-defined]
    assert (row.kind, row.recipient_user_id, row.visit_id) == ("PLATFORM_ACTION_NOTICE", recipient.id, None)
    html, text = _plain(email.html), _read(email.text)
    for part in (html, text):
        # Who, what, about which account, when: in both languages.
        for other in ("ar", "en"):
            assert BODIES[action, other] in part, (action, other)
        assert "Nadia Saleh" in part and "nadia@acme.example" in part
        assert "Hello Amal Haddad," in part and "مرحبًا Amal Haddad،" in part
        assert "If you did not expect this, contact the platform owner" in part
        assert "فتواصل مع مالك المنصة وراجع قائمة مديري النظام في شركتك." in part
    assert "Administrator: Nadia Saleh" in text and "مدير النظام: Nadia Saleh" in text
    assert "Email address: nadia@acme.example" in text and "البريد الإلكتروني: nadia@acme.example" in text
    assert {"en": "Security notice", "ar": "تنبيه أمني"}[
        language
    ] in html  # the pill, in the leading language
    # No credential, no link to follow, no network address: there is nothing to click.
    for part in (email.html, email.text):
        assert "http" not in part.replace("http://www.w3.org/1999/xhtml", "") and "#token=" not in part
        assert "reset-password" not in part and "password:" not in part.lower()
    assert email.reset_url is None and email.pass_url is None
    # The company's own e-mail (B12-22): this company has no logo, so its name heads the notice and
    # the message carries no image; nothing of the product is in it.
    assert email.inline_images == ()
    assert email.sender == f'"{"أكمي القابضة" if language == "ar" else "Acme Holding"}" <visitors@demo.test>'
    assert "Sent by Acme Holding." in text and "أُرسلت من أكمي القابضة." in text
    for part in (email.subject, email.sender, email.html, email.text):
        for word in ("Mawdoo3", "موضوع", "Visitors", "زوار", "on behalf of", "نيابةً عن"):
            assert word not in part, word


def test_a_notice_isolates_the_names_it_shows() -> None:
    """A name keeps its own direction inside the other language's text, and cannot leave its place."""
    company = _company(default_language="ar")
    recipient = _user(company, "أمل حداد", "amal@acme.example")
    about = _user(company, "</span><script>alert(1)</script>", "nadia@acme.example")
    email = _service().queue_platform_notice(recipient, action="admin_added", about=about, when=START).email
    assert "<script>" not in email.html and "&lt;/span&gt;&lt;script&gt;" in email.html
    # The Arabic name in the English greeting, the Latin company in the Arabic sentence.
    assert 'Hello <span dir="rtl">أمل حداد</span>,' in email.html
    # The address, left to right.
    assert 'dir="ltr" class="vik" style="display:block;margin-top:3px;' in email.html
    assert f"Hello {FSI}أمل حداد{PDI}," in email.text
    assert f"البريد الإلكتروني: {LRI}nadia@acme.example{PDI}" in email.text
    assert "email" in LEFT_TO_RIGHT_VALUES


def test_the_notice_is_the_product_s_text_and_has_both_languages_in_the_catalog() -> None:
    assert (
        EmailKind.PLATFORM_ACTION_NOTICE not in EDITABLE
        and EmailKind.PLATFORM_ACTION_NOTICE not in EDITABLE_EMAIL_KINDS
    )
    keys = [key for key in MESSAGES if key.startswith("platform.")]
    assert len(keys) == 10
    for action in ("admin_added", "reset_sent"):
        for part in ("subject", "preheader", "heading", "body"):
            assert f"platform.{part}.{action}" in keys
    # The platform owner is named by that role only.
    for key in keys:
        assert "{name}" not in MESSAGES[key][EN] and "{name}" not in MESSAGES[key][AR]


def test_a_company_s_texts_never_reach_the_notice() -> None:
    company = _company()
    texts = {
        "PLATFORM_ACTION_NOTICE": {EN: {"heading": "Nothing happened", "footer_note": "Ignore this"}},
        "PASSWORD_RESET": {EN: {"heading": "Nothing happened"}},
    }
    service = _service(texts)
    recipient, about = _user(company, language="en"), _user(company, "Nadia Saleh", "nadia@acme.example")
    notice = service.queue_platform_notice(recipient, action="reset_sent", about=about, when=START).email
    reset = service.queue_password_reset(recipient, "T" * 43, sent_by_platform_owner=True).email
    for email in (notice, reset):
        assert "Nothing happened" not in email.html and "Ignore this" not in email.html
