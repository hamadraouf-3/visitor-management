"""The texts of an e-mail that a company's administrator may change (Phase 11, B11-20 to B11-27).

Only words change. The layout, the logo, the colours, the QR code, the details grid (date, time, host,
department, address, purpose), the pass link and its button target, the window of validity and every
security line ("This pass is personal", the reply instructions, who sent the message) stay the product's,
so an edited e-mail cannot be broken or turned into something else.

Each editable kind (`EDITABLE`) has a fixed list of fields, a fixed allow-list of variables and, for some
fields, variables that must appear. The product's own text of a field (`default_text`) comes from the
catalog of `app.email.i18n`, its placeholders renamed to the documented variable names; `closing` and
`footer_note` are extra lines that are empty by default.

A company's text is plain text: line breaks (in multi-line fields) and `{variable}` placeholders only.
`check_text` refuses anything else with a field code: an unknown placeholder, a missing required one, a
brace that is not part of a placeholder, markup (`<tag`, `&entity;`), control and text-direction
characters, line breaks in a one-line field, and texts longer than the field's limit.

The limits count the text, and a variable's value can be far longer than its name (a purpose has up to
500 characters, `{purpose}` nine). What bounds the e-mail a company's texts can make (B11-40):

* a variable appears at most `MAX_VARIABLE_USES` times in one text (`placeholder_repeated`), so a text
  renders to at most its own length plus that many of each value;
* `{purpose}`, free text that a host types for one visit, is not a variable of a subject
  (`placeholder_not_allowed`): a subject names who writes and about what, it is stored in the e-mail log
  and it is the one text shown without the label that says who provided it;
* a rendered subject is cut to `headers.SUBJECT_MAX_LENGTH` characters (`subject_line`), and every
  other text to `rendered_limit` characters, values included (twice the text's own limit): the bound
  that holds whatever the values are. The cut ends with an ellipsis and never splits a value's markup.

A saved text is used only while it passes these checks (`usable_texts`): one saved before a rule existed
gives way to the product's text instead of sending what the rule is there to prevent.

`render_text` / `render_html` / `render_subject` put the values in exactly as the catalog's values are put
in (`app.email.i18n.translate_*`): every value escaped on its own in HTML, names and companies isolated in
their own direction (`app.email.bidi`), dates and times inserted as the service wrote them, and a value
that ends a sentence taking the place of the text's own full stop. The text itself is escaped in HTML, so
nothing a company types can become markup. A value that holds a time range stays on one line in HTML
(`formatting.on_one_line`, B11-47), as it does in the product's own sentences. Subjects get values as
they are and are finished like every subject (`headers.subject_line`): one line, no direction controls,
no encoded word, bounded.
"""

import re
from collections.abc import Mapping
from dataclasses import dataclass, field

from markupsafe import Markup, escape

from app.core.field_errors import FieldCode, FieldProblem
from app.email.bidi import Direction, isolate_html, isolate_text
from app.email.formatting import on_one_line
from app.email.headers import cut_short, subject_line
from app.email.i18n import DIRECTION, MESSAGES, SENTENCE_END
from app.models.enums import EDITABLE_EMAIL_KINDS, EmailKind, Language, TemplateField

# A placeholder: `{name}`, a variable name of lowercase letters, digits and underscores.
PLACEHOLDER = re.compile(r"\{([a-z][a-z0-9_]*)\}")
_BRACE = re.compile(r"[{}]")
# Markup that a mail client or a reader could take for HTML: a tag opener (`<b`, `</`, `<!`, `<?`) or a
# character reference (`&amp;`, `&#60;`, `&#x3c;`). A lone `<` or `&` in words ("a < b", "R&D") is text.
_MARKUP = re.compile(r"<[A-Za-z/!?]|&(?:#[0-9]+|#[xX][0-9A-Fa-f]+|[A-Za-z][A-Za-z0-9]*);")
# Control characters other than the line feed (C0, DEL, C1), and the Unicode line and paragraph
# separators. Carriage returns are turned into line feeds before the check (`normalise_text`).
_CONTROL = re.compile(r"[\x00-\x09\x0b-\x1f\x7f-\x9f\N{LINE SEPARATOR}\N{PARAGRAPH SEPARATOR}]")
# Explicit embeddings, overrides and isolates: they reorder what follows them on screen (as for names).
_BIDI_CONTROLS = re.compile(
    r"[‪-‮"
    r"⁦-⁩]"
)
_VALUE_AND_FULL_STOP = re.compile(r"\{([a-z][a-z0-9_]*)\}\.")

# Variables written by the e-mail service in the sentence's own language: inserted as they are (as the
# catalog's FORMATTED_VALUES).
FORMATTED_VARIABLES = frozenset({"date", "time", "timezone"})


@dataclass(frozen=True, slots=True)
class EditableField:
    """One editable text of a kind."""

    name: TemplateField
    # The catalog text the product uses (its placeholders renamed by `rename`), or None for an extra line
    # that is empty unless the company writes one.
    catalog_key: str | None
    multiline: bool
    max_length: int
    rename: Mapping[str, str] = field(default_factory=dict)  # catalog placeholder -> variable
    required: tuple[str, ...] = ()  # variables the text must contain
    forbidden: tuple[str, ...] = ()  # variables of the kind that this text may not use (B11-40)


@dataclass(frozen=True, slots=True)
class EditableKind:
    kind: EmailKind
    variables: tuple[str, ...]  # the allow-list, in the order the API lists it
    fields: tuple[EditableField, ...]

    def field(self, name: TemplateField | str) -> EditableField | None:
        return next((item for item in self.fields if item.name == name), None)


SUBJECT_MAX = 150
# How often one variable may appear in one text (B11-40): enough to name the visitor or the company again
# in a paragraph, and a bound on what a text renders to.
MAX_VARIABLE_USES = 3
# Free text typed for one visit: not a variable of a subject (B11-40).
NOT_IN_SUBJECTS = ("purpose",)
# A text renders to at most this many times its own limit, values included (B11-40): room for every name
# a paragraph can sensibly carry, and a bound that no value's length can move. Beyond it the text is cut
# with an ellipsis, as a subject is.
RENDERED_FACTOR = 2
LINE_MAX = 150
BUTTON_MAX = 40
PARAGRAPH_MAX = 1000
FOOTER_NOTE_MAX = 300

_VISIT_VARIABLES = (
    "visitor_name",
    "company",
    "host_name",
    "date",
    "time",
    "timezone",
    "department",
    "purpose",
)
_ARRIVAL_VARIABLES = (
    "host_name",
    "visitor_name",
    "visitor_company",
    "company",
    "date",
    "time",
    "timezone",
    "purpose",
)


def _common_fields(*, greeting_name: str) -> tuple[EditableField, ...]:
    return (
        EditableField(TemplateField.GREETING, "common.hello", False, LINE_MAX, {"name": greeting_name}),
        EditableField(TemplateField.CLOSING, None, True, PARAGRAPH_MAX),
        EditableField(TemplateField.FOOTER_NOTE, None, True, FOOTER_NOTE_MAX),
    )


def _visitor_kind(kind: EmailKind, prefix: str, intro_key: str, *, button: str | None) -> EditableKind:
    greeting, closing, footer_note = _common_fields(greeting_name="visitor_name")
    fields = [
        # The visitor must be able to tell from the subject which company writes (B11-25).
        EditableField(
            TemplateField.SUBJECT,
            f"{prefix}.subject",
            False,
            SUBJECT_MAX,
            {"company": "company", "date": "date"},
            required=("company",),
            forbidden=NOT_IN_SUBJECTS,
        ),
        EditableField(TemplateField.HEADING, f"{prefix}.heading", False, LINE_MAX, {"company": "company"}),
        greeting,
        EditableField(
            TemplateField.INTRO, intro_key, True, PARAGRAPH_MAX, {"host": "host_name", "company": "company"}
        ),
    ]
    if button is not None:
        fields.append(EditableField(TemplateField.BUTTON, button, False, BUTTON_MAX))
    fields += [closing, footer_note]
    return EditableKind(kind, _VISIT_VARIABLES, tuple(fields))


def _host_arrival() -> EditableKind:
    greeting, closing, footer_note = _common_fields(greeting_name="host_name")
    return EditableKind(
        EmailKind.HOST_ARRIVAL,
        _ARRIVAL_VARIABLES,
        (
            # The host must be able to tell from the subject who has arrived (B11-25).
            EditableField(
                TemplateField.SUBJECT,
                "arrival.subject",
                False,
                SUBJECT_MAX,
                {"visitor": "visitor_name"},
                required=("visitor_name",),
                forbidden=NOT_IN_SUBJECTS,
            ),
            EditableField(TemplateField.HEADING, "arrival.heading", False, LINE_MAX),
            greeting,
            EditableField(
                TemplateField.INTRO,
                "arrival.body",
                True,
                PARAGRAPH_MAX,
                {"visitor": "visitor_name", "time": "time", "zone": "timezone"},
            ),
            closing,
            footer_note,
        ),
    )


EDITABLE: dict[EmailKind, EditableKind] = {
    EmailKind.VISITOR_INVITATION: _visitor_kind(
        EmailKind.VISITOR_INVITATION, "invitation", "invitation.invited", button="invitation.open_pass"
    ),
    EmailKind.VISIT_RESCHEDULED: _visitor_kind(
        EmailKind.VISIT_RESCHEDULED, "rescheduled", "rescheduled.intro", button=None
    ),
    EmailKind.VISIT_CANCELLED: _visitor_kind(
        EmailKind.VISIT_CANCELLED, "cancelled", "cancelled.intro", button=None
    ),
    EmailKind.HOST_ARRIVAL: _host_arrival(),
}
assert tuple(EDITABLE) == EDITABLE_EMAIL_KINDS  # noqa: S101 - one list of editable kinds

# The most characters each field's text may have: the same in every kind that has the field.
FIELD_MAX_LENGTH: dict[TemplateField, int] = {
    item.name: item.max_length for spec in EDITABLE.values() for item in spec.fields
}
assert all(  # noqa: S101 - one limit per field
    item.max_length == FIELD_MAX_LENGTH[item.name] for spec in EDITABLE.values() for item in spec.fields
)

# Overrides of one e-mail as the renderer reads them: language -> field -> text.
type Texts = Mapping[Language, Mapping[str, str]]
# Values of the variables, per language.
type Variables = Mapping[Language, Mapping[str, str]]


def editable_kind(kind: EmailKind | str) -> EditableKind | None:
    try:
        return EDITABLE.get(EmailKind(kind))
    except ValueError:
        return None


def default_text(spec: EditableField, language: Language) -> str:
    """The product's text of a field in `language`, with the documented variable names ("" for an extra
    line)."""
    if spec.catalog_key is None:
        return ""
    text = MESSAGES[spec.catalog_key][language]
    return PLACEHOLDER.sub(lambda match: "{" + spec.rename.get(match.group(1), match.group(1)) + "}", text)


# ---- validation ---------------------------------------------------------------------------------


def normalise_text(value: str) -> str:
    """A submitted text as stored: CRLF and CR become LF, and white space at both ends is removed."""
    return value.replace("\r\n", "\n").replace("\r", "\n").strip()


def placeholders_of(text: str) -> list[str]:
    return PLACEHOLDER.findall(text)


def check_text(spec: EditableField, kind: EditableKind, text: str) -> FieldProblem | None:
    """The first problem of a company's (normalised, non-empty) text for `spec`, or None."""
    if len(text) > spec.max_length:
        return FieldProblem(
            FieldCode.TOO_LONG, f"Enter at most {spec.max_length} characters.", {"max": spec.max_length}
        )
    if not spec.multiline and ("\n" in text or "\t" in text):
        return FieldProblem(FieldCode.LINE_BREAKS, "Enter this on one line, without line breaks or tabs.")
    if _CONTROL.search(text):
        return FieldProblem(FieldCode.CONTROL_CHARACTERS, "Remove unsupported control characters.")
    if _BIDI_CONTROLS.search(text):
        return FieldProblem(FieldCode.BIDI_CONTROLS, "Remove text-direction control characters.")
    if _MARKUP.search(text):
        return FieldProblem(
            FieldCode.MARKUP_NOT_ALLOWED,
            "Write plain text: tags and HTML character references are not allowed.",
        )
    if _BRACE.search(PLACEHOLDER.sub("", text)):
        return FieldProblem(
            FieldCode.INVALID_PLACEHOLDER,
            "Write a variable as its name in braces, for example {visitor_name}; braces mark variables only.",
        )
    used = placeholders_of(text)
    for name in used:
        if name not in kind.variables:
            return FieldProblem(
                FieldCode.UNKNOWN_PLACEHOLDER,
                f"{{{name}}} is not a variable of this e-mail.",
                {"name": name, "allowed": kind.variables},
            )
    for name in used:
        if name in spec.forbidden:
            return FieldProblem(
                FieldCode.PLACEHOLDER_NOT_ALLOWED,
                f"{{{name}}} cannot be used in this text.",
                {"name": name},
            )
    for name in used:
        if used.count(name) > MAX_VARIABLE_USES:
            return FieldProblem(
                FieldCode.PLACEHOLDER_REPEATED,
                f"Use {{{name}}} at most {MAX_VARIABLE_USES} times in this text.",
                {"name": name, "max": MAX_VARIABLE_USES},
            )
    for name in spec.required:
        if name not in used:
            return FieldProblem(
                FieldCode.PLACEHOLDER_REQUIRED,
                f"Include the variable {{{name}}} in this text.",
                {"name": name},
            )
    return None


def usable_texts(kind: EmailKind | str, texts: Texts) -> Texts:
    """The texts of `texts` that an e-mail of `kind` may use: those that pass `check_text` today. A text
    saved before a check existed, or written past the API, is left out, and its field shows the product's
    text. So what the checks bound (the size of an e-mail, what a subject can hold) is bounded for every
    e-mail, whatever is stored (B11-40)."""
    spec = editable_kind(kind)
    if spec is None:
        return {}
    usable: dict[Language, dict[str, str]] = {}
    for language, fields in texts.items():
        for name, text in fields.items():
            definition = spec.field(name)
            if definition is not None and text and check_text(definition, spec, text) is None:
                usable.setdefault(language, {})[name] = text
    return usable


# ---- rendering ----------------------------------------------------------------------------------


def _without_doubled_full_stops(text: str, values: Mapping[str, str]) -> str:
    def full_stop(match: re.Match[str]) -> str:
        value = values.get(match.group(1), "")
        return match.group(0)[:-1] if value.rstrip().endswith(SENTENCE_END) else match.group(0)

    return _VALUE_AND_FULL_STOP.sub(full_stop, text)


def _parts(text: str) -> list[tuple[str, str | None]]:
    """`(literal, variable or None)` pieces of a text."""
    pieces: list[tuple[str, str | None]] = []
    position = 0
    for match in PLACEHOLDER.finditer(text):
        pieces.append((text[position : match.start()], match.group(1)))
        position = match.end()
    pieces.append((text[position:], None))
    return pieces


def rendered_limit(field: TemplateField | str) -> int:
    """The most characters the text of `field` renders to, values included (B11-40): `RENDERED_FACTOR`
    times the most characters the text itself may have."""
    return RENDERED_FACTOR * FIELD_MAX_LENGTH[TemplateField(field)]


def _pieces(text: str, values: Mapping[str, str], limit: int | None) -> list[tuple[str, str | None, str]]:
    """`(literal, variable or None, the variable's value)` pieces of a text with its values, in at most
    `limit` characters in all (None: unbounded).

    Where the limit falls, the literal or the value it falls in is cut short with an ellipsis and the
    rest is left out. A value is cut before it is escaped and isolated, so the markup and the isolate
    characters around it stay whole."""
    pieces = [
        (literal, name, values.get(name, "") if name is not None else "")
        for literal, name in _parts(_without_doubled_full_stops(text, values))
    ]
    if limit is None or sum(len(literal) + len(value) for literal, _, value in pieces) <= limit:
        return pieces
    room = limit - 1  # for the ellipsis
    bounded: list[tuple[str, str | None, str]] = []
    for literal, name, value in pieces:
        if len(literal) > room:
            bounded.append((cut_short(literal, room + 1), None, ""))
            break
        room -= len(literal)
        if len(value) > room:
            bounded.append((literal, name, cut_short(value, room + 1)))
            break
        room -= len(value)
        bounded.append((literal, name, value))
    return bounded


def render_text(text: str, values: Mapping[str, str], language: Language, *, limit: int | None = None) -> str:
    """A company's text for a plain-text body: names and companies isolated with Unicode isolates, in at
    most `limit` characters before the isolate characters are added."""
    context: Direction = DIRECTION[language]
    out: list[str] = []
    for literal, name, value in _pieces(text, values, limit):
        out.append(literal)
        if name is not None:
            out.append(value if name in FORMATTED_VARIABLES else isolate_text(value, context))
    return "".join(out)


def render_html(
    text: str, values: Mapping[str, str], language: Language, *, limit: int | None = None
) -> Markup:
    """A company's text for HTML: the text escaped (line breaks as `<br>`), every value escaped on its own
    and names in a `<span dir>` of their own, in at most `limit` characters of text."""
    context: Direction = DIRECTION[language]
    out = Markup("")
    for literal, name, value in _pieces(text, values, limit):
        out += Markup("<br>").join(escape(line) for line in literal.split("\n"))
        if name is not None:
            out += on_one_line(value) if name in FORMATTED_VARIABLES else isolate_html(value, context)
    return out


def render_subject(text: str, values: Mapping[str, str]) -> str:
    """A company's subject: values inserted as they are, then finished like every subject
    (`headers.subject_line`: one line, no direction controls, no encoded word, bounded)."""
    out: list[str] = []
    for literal, _name, value in _pieces(text, values, None):
        out.append(literal)
        out.append(value)
    return subject_line("".join(out))
