"""Dates and times for e-mails, in the company's timezone and with fixed wording in each language (no
dependence on the server's locale).

English: `Monday, 5 October 2026`, `Tue, 6 Oct` (the short form the application uses too), `09:00`,
`Amman time, UTC+3`.

Arabic (B10-8, the frontend's format): Levantine month names (كانون الثاني … كانون الأول), Latin digits,
the 24-hour clock and the Arabic comma, as `Intl.DateTimeFormat('ar-JO-u-nu-latn')` writes them:
`الاثنين، 5 تشرين الأول 2026`, `09:00`, `بتوقيت عمّان، UTC+3`. Arabic has no abbreviated weekday or month
names, so the short form is `الثلاثاء، 6 تشرين الأول`.

Visitors read a place name rather than an IANA identifier: `Asia/Amman` is shown as `Amman time` (English)
or `بتوقيت عمّان` (Arabic, for the zones of `_ARABIC_PLACES`). Zones without a place (`UTC`, `Etc/GMT-3`,
legacy names such as `EST5EDT`), and in Arabic places without an Arabic name, are shown by their UTC
offset.

Line breaks (the frontend's rule, phase 10 review): an Arabic date keeps its day, month and year on one line
(`5 تشرين الأول 2026` with no-break spaces: the Levantine month names are two words, and a mail client split
`تشرين` / `الأول`), and so does the Arabic zone label; a time range never breaks at its dash. A line may still
break after the weekday's comma and between a date and its time.

A moment on another day than the visit (a pass window that crosses midnight) is written in two ways.
Under a label and in the details grid it is a list, as the interface writes it: `Tue, 6 Oct, 00:30`,
`الثلاثاء، 6 تشرين الأول، الساعة 00:30`. Inside an Arabic sentence the commas of that list read as the
sentence's own, so there the day is introduced by «يوم» and the time by «الساعة», with no comma
(B12-23): «تنتهي صلاحية بطاقتك يوم الثلاثاء 6 تشرين الأول الساعة 00:30», as the other sentences of the
catalog say a date and a time («يوم {date} الساعة {time}»). The day and its month, «يوم» and the
weekday, and «الساعة» and the time each stay on one line.

The range's no-break spaces are not enough on their own (B11-47): a line may break after an en dash even
when a no-break space follows it (UAX #14, LB12a: the dash is a break-after character), and mail clients
did break a range after its dash inside a sentence. In an HTML sentence a value that holds a range is
therefore wrapped in a span that does not wrap (`on_one_line`), which every mail client honours. A
character that forbids the break (U+2060 WORD JOINER, which the web application uses) is not put into
e-mails: a client whose font lacks it shows a box. Plain text has no such markup and keeps the no-break
spaces."""

from dataclasses import dataclass
from datetime import datetime, timedelta

from markupsafe import Markup, escape

from app.core.time import as_zone
from app.models.enums import Language

EN, AR = Language.EN, Language.AR

_WEEKDAYS = {
    EN: ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"),
    AR: ("الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت", "الأحد"),
}
_MONTHS = {
    EN: (
        "January",
        "February",
        "March",
        "April",
        "May",
        "June",
        "July",
        "August",
        "September",
        "October",
        "November",
        "December",
    ),
    # The Levantine (Syriac-derived) month names used in Jordan, Syria, Lebanon and Palestine.
    AR: (
        "كانون الثاني",
        "شباط",
        "آذار",
        "نيسان",
        "أيار",
        "حزيران",
        "تموز",
        "آب",
        "أيلول",
        "تشرين الأول",
        "تشرين الثاني",
        "كانون الأول",
    ),
}
# Arabic names of the places of the zones companies in the region use most; another zone is shown by its
# UTC offset in Arabic (a Latin place name inside Arabic text reads poorly).
_ARABIC_PLACES = {
    "Asia/Amman": "عمّان",
    "Asia/Riyadh": "الرياض",
    "Asia/Dubai": "دبي",
    "Asia/Kuwait": "الكويت",
    "Asia/Qatar": "الدوحة",
    "Asia/Bahrain": "البحرين",
    "Asia/Muscat": "مسقط",
    "Asia/Baghdad": "بغداد",
    "Asia/Damascus": "دمشق",
    "Asia/Beirut": "بيروت",
    "Asia/Jerusalem": "القدس",
    "Asia/Hebron": "الخليل",
    "Asia/Gaza": "غزة",
    "Asia/Aden": "عدن",
    "Africa/Cairo": "القاهرة",
    "Africa/Khartoum": "الخرطوم",
    "Africa/Tripoli": "طرابلس",
    "Africa/Tunis": "تونس",
    "Africa/Algiers": "الجزائر",
    "Africa/Casablanca": "الدار البيضاء",
    "Africa/Nouakchott": "نواكشوط",
    "Europe/Istanbul": "إسطنبول",
    "Europe/London": "لندن",
    "Europe/Paris": "باريس",
    "Europe/Berlin": "برلين",
    "America/New_York": "نيويورك",
}
_ARABIC_COMMA = "\N{ARABIC COMMA}"
_NBSP = "\N{NO-BREAK SPACE}"


def _unbreakable(text: str) -> str:
    """The text with no-break spaces: kept on one line."""
    return text.replace(" ", _NBSP)


def _local(instant: datetime, timezone: str) -> datetime:
    return instant.astimezone(as_zone(timezone))


def format_date(instant: datetime, timezone: str, language: Language = EN) -> str:
    local = _local(instant, timezone)
    weekday, month = _WEEKDAYS[language][local.weekday()], _MONTHS[language][local.month - 1]
    if language == AR:
        return f"{weekday}{_ARABIC_COMMA} " + _unbreakable(f"{local.day} {month} {local.year}")
    return f"{weekday}, {local.day} {month} {local.year}"


def _short_date(local: datetime, language: Language) -> str:
    weekday, month = _WEEKDAYS[language][local.weekday()], _MONTHS[language][local.month - 1]
    if language == AR:
        return f"{weekday}{_ARABIC_COMMA} " + _unbreakable(f"{local.day} {month}")
    return f"{weekday[:3]}, {local.day} {month[:3]}"


def format_time(instant: datetime, timezone: str) -> str:
    """`09:00`: the 24-hour clock with Latin digits, in both languages."""
    return _local(instant, timezone).strftime("%H:%M")


def utc_offset(instant: datetime, timezone: str) -> str:
    """The offset in effect at `instant`: `UTC+3`, `UTC+5:30`, `UTC-4`, or `UTC` when it is zero."""
    offset = _local(instant, timezone).utcoffset() or timedelta(0)
    minutes = int(offset.total_seconds() // 60)
    if minutes == 0:
        return "UTC"
    sign = "+" if minutes > 0 else "-"
    hours, rest = divmod(abs(minutes), 60)
    return f"UTC{sign}{hours}" + (f":{rest:02d}" if rest else "")


def _place(timezone: str, language: Language) -> str | None:
    if language == AR:
        return _ARABIC_PLACES.get(timezone)
    area, _, place = timezone.rpartition("/")
    if not area or area == "Etc":
        return None
    return place.replace("_", " ")


def zone_name(instant: datetime, timezone: str, language: Language = EN) -> str:
    """`Amman time` / `بتوقيت عمّان`, or the UTC offset at `instant` for a zone without a place name
    (`بتوقيت UTC+3` in Arabic)."""
    place = _place(timezone, language)
    if language == AR:
        return f"بتوقيت {place or utc_offset(instant, timezone)}"
    return f"{place} time" if place else utc_offset(instant, timezone)


def timezone_label(instant: datetime, timezone: str, language: Language = EN) -> str:
    """`Amman time, UTC+3` / `بتوقيت عمّان، UTC+3`: the place and the offset in effect at `instant` (the
    offset alone without a place)."""
    place = _place(timezone, language)
    offset = utc_offset(instant, timezone)
    if language == AR:
        return _unbreakable(f"بتوقيت {place}{_ARABIC_COMMA} {offset}" if place else f"بتوقيت {offset}")
    return f"{place} time, {offset}" if place else offset


EN_DASH = "\N{EN DASH}"
# A time range's dash with no-break spaces on both sides: "09:00 - 13:00" never breaks.
RANGE_DASH = f"{_NBSP}{EN_DASH}{_NBSP}"
_NEXT_DAY = {EN: "the next day", AR: "من اليوم التالي"}
_ON_ONE_LINE = Markup('<span style="white-space:nowrap;">{}</span>')


def on_one_line(value: str) -> Markup:
    """A date, time or zone value for an HTML sentence, escaped. One that holds a time range (`RANGE_DASH`)
    stays on one line, dash included (see the module): the product's own sentences and a company's texts
    insert their formatted values through this (`i18n.translate_html`, `editable.render_html`)."""
    if RANGE_DASH not in value:
        return escape(value)
    return _ON_ONE_LINE.format(value)


def format_span(start: datetime, end: datetime, timezone: str, language: Language = EN) -> str:
    """The times of a span whose date is shown separately (the e-mails' Date row): `09:00 - 13:00` (with
    an en dash, unbreakable) on one local day, `22:42 - 00:42 the next day` across one midnight, and with
    short dates on both ends beyond that (visits last at most 24 hours, so only other spans get there),
    where the line may break after the dash."""
    local_start, local_end = _local(start, timezone), _local(end, timezone)
    days = (local_end.date() - local_start.date()).days
    if days == 0:
        return f"{local_start:%H:%M}{RANGE_DASH}{local_end:%H:%M}"
    if days == 1:
        return f"{local_start:%H:%M}{RANGE_DASH}{local_end:%H:%M} {_NEXT_DAY[language]}"
    return f"{_day_and_time(local_start, language)}{_NBSP}{EN_DASH} {_day_and_time(local_end, language)}"


def _day_and_time(local: datetime, language: Language) -> str:
    """A short date and a time, the language's comma between them: `Tue, 6 Oct, 00:30`; in Arabic with
    «الساعة» before the time, as the interface writes a moment on another day: `الثلاثاء، 6 تشرين الأول،
    الساعة 00:30`."""
    if language == AR:
        return f"{_short_date(local, language)}{_ARABIC_COMMA} الساعة{_NBSP}{local:%H:%M}"
    return f"{_short_date(local, language)}, {local:%H:%M}"


def _day_and_time_in_a_sentence(local: datetime, language: Language) -> str:
    """A moment on another day than the visit, as a sentence says it (see the module). English keeps
    the list form, `Tue, 6 Oct, 00:30`; Arabic is «يوم الثلاثاء 6 تشرين الأول الساعة 00:30»."""
    if language != AR:
        return _day_and_time(local, language)
    weekday, month = _WEEKDAYS[AR][local.weekday()], _MONTHS[AR][local.month - 1]
    day = _unbreakable(f"{local.day} {month}")
    return f"يوم{_NBSP}{weekday} {day} الساعة{_NBSP}{local:%H:%M}"


# The end of the pass window on the visit's own day, after "Your pass expires" / «تنتهي صلاحية بطاقتك»:
# the English sentence has its own "at"; the Arabic preposition comes with the time, because another
# day's moment takes none («يوم … الساعة …»).
_UNTIL_A_TIME = {EN: "{}", AR: "عند {}"}


@dataclass(frozen=True, slots=True)
class VisitTimes:
    """Display strings for a visit's schedule and pass window, in one language.

    The window is worded from the visitor's side: `check_in_from` (when the pass starts to work) and
    `expires_at` (when it stops), each with a short date when it falls on another day than the visit.
    Those two stand under a label (the pass card); `from_phrase` and `until_phrase` are the same two
    moments as a sentence says them ("You can check in from …. Your pass expires …"), which differs in
    Arabic (see the module). `dated`: one of them is on another day, so its text carries a date and is
    far longer than a time."""

    date: str
    time: str
    timezone: str  # `Amman time, UTC+3`
    zone: str  # `Amman time`
    check_in_from: str
    expires_at: str
    from_phrase: str  # after "from" / «ابتداءً من»
    until_phrase: str  # after "Your pass expires at" / «وتنتهي صلاحية بطاقتك»
    dated: bool

    @classmethod
    def build(
        cls,
        *,
        scheduled_start: datetime,
        scheduled_end: datetime,
        window_start: datetime,
        window_end: datetime,
        timezone: str,
        language: Language = EN,
    ) -> VisitTimes:
        visit_day = _local(scheduled_start, timezone).date()

        def on_visit_day(instant: datetime) -> str:
            local = _local(instant, timezone)
            if local.date() == visit_day:
                return f"{local:%H:%M}"
            return _day_and_time(local, language)

        def in_a_sentence(instant: datetime, a_time: str = "{}") -> str:
            local = _local(instant, timezone)
            if local.date() == visit_day:
                return a_time.format(f"{local:%H:%M}")
            return _day_and_time_in_a_sentence(local, language)

        return cls(
            date=format_date(scheduled_start, timezone, language),
            time=format_span(scheduled_start, scheduled_end, timezone, language),
            timezone=timezone_label(scheduled_start, timezone, language),
            zone=zone_name(scheduled_start, timezone, language),
            check_in_from=on_visit_day(window_start),
            expires_at=on_visit_day(window_end),
            from_phrase=in_a_sentence(window_start),
            until_phrase=in_a_sentence(window_end, _UNTIL_A_TIME[language]),
            dated=any(
                _local(instant, timezone).date() != visit_day for instant in (window_start, window_end)
            ),
        )
