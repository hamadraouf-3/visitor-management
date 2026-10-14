"""Jinja2 rendering of e-mail templates (HTML with autoescape + plain-text alternative).

Every e-mail is bilingual (Phase 10, B10-7): `render(..., language=...)` names the leading language, and
the templates render one section per language with the catalog of `app.email.i18n` (`t`), the leading one
first. Templates index per-language values (`company_name[lang]`, `times[lang]`, `brand[lang]`,
`product[lang]`, `footer[lang]`) that the service supplies for both languages.

Values keep their own direction inside the other language's text (B10-14, `app.email.bidi`):
- `t(lang, key, **values)` gives escaped markup with each name in a `<span dir>` in an HTML template,
  and text with Unicode isolates in a plain-text one;
- `t_text(...)` gives the text form for an HTML attribute (an image's `alt`);
- `value | isolate(lang)` isolates a value printed on its own in a sentence or a "Label: value" line;
- `value | direction` is the `dir` of a value shown as a block (the details grid);
- `edited(lang, field)` is a company's own text of an editable field (Phase 11, B11-20), or "" when the
  company has none: the templates fall back to the catalog (`edited(...) or t(...)`). The service passes
  the texts as `overrides` and their values as `variables`, per language.

Light and dark (Phase 13, B13-1): every e-mail has a light design and a dark one, which a client that
honours `prefers-color-scheme` shows. `scheme` is what the e-mail is rendered for: None is the e-mail as
it is sent (the light design, with the dark one in a media query); "light" and "dark" are previews of
one design alone, whatever the viewer's own scheme (B13-5): a document in a frame follows the device's
scheme, and nothing outside it can change that.

Weight (B13-8): Gmail clips a message whose HTML passes about 102 KB, so what the templates repeat in
every message is kept short (macros.html), and an HTML template is read without the indentation of its
lines (`_TemplateLoader`).
"""

import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any, Literal

from jinja2 import (
    Environment,
    PackageLoader,
    StrictUndefined,
    pass_context,
    pass_eval_context,
    select_autoescape,
)
from jinja2.nodes import EvalContext
from jinja2.runtime import Context
from markupsafe import Markup

from app.email.bidi import Direction, direction_of, isolate_html, isolate_text
from app.email.editable import render_html, render_text, rendered_limit
from app.email.headers import subject_line
from app.email.i18n import DIRECTION, LANGUAGE_NAMES, other_language, translate_html, translate_text
from app.email.logos import PLATE_RADIUS
from app.models.enums import Language

# The one design a preview shows (see the module); None renders the e-mail as it is sent.
type Scheme = Literal["light", "dark"]
# The brand logo in the header of every e-mail (`assets/brand-logo.png`, 462 x 149 px, the white wordmark on
# the header's teal: B10-17), shown at this size: the same aspect ratio, about 3.7 image pixels per CSS pixel
# for high-density screens.
LOGO_WIDTH = 124
LOGO_HEIGHT = 40
# Where each language's text starts and ends (the section's `align` / `text-align`).
START = {Language.AR: "right", Language.EN: "left"}
END = {Language.AR: "left", Language.EN: "right"}
# Between the items of a list in running text ("Monday, 5 October 2026, 10:00").
COMMA = {Language.AR: "، ", Language.EN: ", "}
# The white space that starts a line of a template.
_INDENTATION = re.compile(r"^[ \t]+", re.MULTILINE)
# A line break between two tags of a template, with the names of both (a tag whose own text holds a `<`
# or a `>`, as a template expression may, is left alone) ...
_BREAK_BETWEEN_TAGS = re.compile(r"(</?([a-zA-Z][a-zA-Z0-9]*)[^<>]*>)\r?\n(?=</?([a-zA-Z][a-zA-Z0-9]*))")
# ... and the tags beside which HTML draws no such white space: before or after a block or a part of a
# table it starts or ends a line, where it is dropped. Between two inline tags it is a space.
_BLOCK_TAGS = frozenset(
    {"html", "head", "body", "meta", "title", "style", "table", "tr", "td", "p", "div", "h1", "h2", "h3"}
)


def _joined(match: re.Match[str]) -> str:
    before, after = match.group(2).lower(), match.group(3).lower()
    return match.group(1) if before in _BLOCK_TAGS or after in _BLOCK_TAGS else match.group(0)


def compact_html(source: str) -> str:
    """An HTML template without the white space HTML does not draw (B13-8): the indentation of its lines,
    and a line break between two tags where one of them is a block's or a table's (about 2.2 KB of the
    worst invitation together). HTML draws the white space that starts a line together with the line
    break before it, as one space at most, and none at the start or the end of a block; no template sets
    `white-space: pre` on a line of its own. What a client draws does not change, and only the
    template's own text loses it, never a value: this runs on the template, before anything is put in."""
    return _BREAK_BETWEEN_TAGS.sub(_joined, _INDENTATION.sub("", source))


class _TemplateLoader(PackageLoader):
    """The package's templates: an HTML one `compact_html`, a plain-text one as it is."""

    def get_source(
        self, environment: Environment, template: str
    ) -> tuple[str, str, Callable[[], bool] | None]:
        source, filename, uptodate = super().get_source(environment, template)
        if template.endswith(".html"):
            source = compact_html(source)
        return source, filename, uptodate


@pass_eval_context
def _translate(
    eval_context: EvalContext, language: Language | str, key: str, /, **values: object
) -> Markup | str:
    """`t` in templates: markup in HTML (autoescaped) templates, text in plain-text ones."""
    if eval_context.autoescape:
        return translate_html(language, key, **values)
    return translate_text(language, key, **values)


@pass_eval_context
def _isolate(
    eval_context: EvalContext, value: str | None, language: Language | str, direction: Direction | None = None
) -> Markup | str | None:
    """`value | isolate(lang)`: `value` isolated as a value in a sentence of `lang`."""
    if value is None:
        return None
    context = DIRECTION[Language(language)]
    if eval_context.autoescape:
        return isolate_html(value, context, direction)
    return isolate_text(value, context, direction)


@pass_context
def _edited(context: Context, language: Language | str, field: str) -> Markup | str:
    """`edited(lang, field)`: the company's own text of an editable field (B11-20) with the e-mail's
    variables put in (`app.email.editable`), as markup in HTML templates and as text in plain-text ones;
    "" when the company has none, so a template writes `edited(lang, "heading") or t(lang, ...)`."""
    lang = Language(language)
    overrides = context.get("overrides") or {}
    text = overrides.get(lang, {}).get(field)
    if not text:
        return ""
    values = (context.get("variables") or {}).get(lang, {})
    limit = rendered_limit(field)  # what the text may render to, whatever its values are (B11-40)
    if context.eval_ctx.autoescape:
        return render_html(text, values, lang, limit=limit)
    return render_text(text, values, lang, limit=limit)


@dataclass(frozen=True, slots=True)
class RenderedEmail:
    subject: str
    html: str
    text: str


class EmailRenderer:
    def __init__(self) -> None:
        self._environment = Environment(
            loader=_TemplateLoader("app.email", "templates"),
            # Visitor/user-supplied values are escaped in HTML; plain-text templates are not HTML.
            autoescape=select_autoescape(enabled_extensions=("html",), default_for_string=True),
            undefined=StrictUndefined,
            trim_blocks=True,
            lstrip_blocks=True,
            keep_trailing_newline=True,
        )
        self._environment.filters.update(isolate=_isolate, direction=direction_of)
        self._environment.globals.update(
            t=_translate,
            t_text=translate_text,
            edited=_edited,
            DIRECTION=DIRECTION,
            START=START,
            END=END,
            COMMA=COMMA,
            LANGUAGE_NAMES=LANGUAGE_NAMES,
            LOGO_WIDTH=LOGO_WIDTH,
            LOGO_HEIGHT=LOGO_HEIGHT,
            LOGO_PLATE_RADIUS=PLATE_RADIUS,
        )

    def render(
        self,
        template: str,
        *,
        subject: str,
        context: Mapping[str, Any],
        language: Language,
        scheme: Scheme | None = None,
    ) -> RenderedEmail:
        """Render `template` with `language` leading and the other language after it: as it is sent, or
        in the one design `scheme` names (a preview)."""
        # The Subject as every provider sends it and as the e-mail log and a preview show it (B11-40,
        # B11-41): one line, no direction controls, no encoded word, bounded.
        subject = subject_line(subject)
        lead = Language(language)
        values = {
            "subject": subject,
            "lead": lead,
            "other": other_language(lead),
            "scheme": scheme,
            **context,
        }
        html = self._environment.get_template(f"{template}.html").render(values)
        text = self._environment.get_template(f"{template}.txt").render(values)
        return RenderedEmail(subject=subject, html=html, text=text)
