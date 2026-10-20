"""Schemas of a company's own e-mail texts (/api/v1/email-templates, Phase 11, B11-20 to B11-31)."""

from enum import StrEnum

from app.models.enums import Language, TemplateField
from app.schemas.common import QueryModel, RequestModel, ResponseModel, UTCDatetime


class EditableEmailKind(StrEnum):
    """The e-mails whose texts a company may change (B11-20; the host's three of a scheduled visit since
    Phase 14, B14-2); the security e-mails may not (B11-21)."""

    VISITOR_INVITATION = "VISITOR_INVITATION"
    VISIT_RESCHEDULED = "VISIT_RESCHEDULED"
    VISIT_CANCELLED = "VISIT_CANCELLED"
    HOST_ARRIVAL = "HOST_ARRIVAL"
    HOST_VISIT_SCHEDULED = "HOST_VISIT_SCHEDULED"
    HOST_VISIT_RESCHEDULED = "HOST_VISIT_RESCHEDULED"
    HOST_VISIT_CANCELLED = "HOST_VISIT_CANCELLED"


class EmailScheme(StrEnum):
    """Which design of an e-mail a preview shows (Phase 13, B13-5): `light` or `dark`, alone, as a mail
    client in that scheme shows it, whatever the colour scheme of the device the preview is seen on."""

    LIGHT = "light"
    DARK = "dark"


class LanguageTexts(ResponseModel):
    ar: str
    en: str


class OptionalLanguageTexts(ResponseModel):
    ar: str | None
    en: str | None


class EmailTemplateField(ResponseModel):
    """One editable text: its limits, the product's text and the company's (null: the product's)."""

    name: TemplateField
    multiline: bool  # line breaks allowed
    max_length: int
    required_variables: list[str]  # each must appear as `{name}` in the company's text
    # Variables of the kind that this text may not use (B11-40): `purpose` in a subject.
    forbidden_variables: list[str]
    default: LanguageTexts  # the product's text ("" for `closing` and `footer_note`: no line by default)
    override: OptionalLanguageTexts  # the company's text, null where it uses the product's


class EmailTemplate(ResponseModel):
    kind: EditableEmailKind
    variables: list[str]  # the allow-list of `{variable}` placeholders of this kind
    max_variable_uses: int  # how often one variable may appear in one text (B11-40)
    fields: list[EmailTemplateField]
    updated_at: UTCDatetime | None  # when the company last changed or reset a text of this kind


class EmailTemplateTexts(RequestModel):
    """Texts of one language. A field that is left out is unchanged; null or blank text returns it to the
    product's text. Plain text only (B11-24): `{variable}` placeholders, and line breaks in multi-line
    fields."""

    subject: str | None = None
    heading: str | None = None
    greeting: str | None = None
    intro: str | None = None
    button: str | None = None
    closing: str | None = None
    footer_note: str | None = None


class _LanguageTexts(RequestModel):
    ar: EmailTemplateTexts | None = None
    en: EmailTemplateTexts | None = None

    def texts(self) -> dict[Language, EmailTemplateTexts | None]:
        return {Language.AR: self.ar, Language.EN: self.en}


class EmailTemplateUpdate(_LanguageTexts):
    """PATCH /email-templates/{kind}: field errors are reported at `ar.<field>` / `en.<field>`."""


class EmailTemplateReset(RequestModel):
    """POST /email-templates/{kind}/reset: one language, or both when `language` is omitted or null."""

    language: Language | None = None


class EmailTemplatePreviewRequest(_LanguageTexts):
    """POST /email-templates/{kind}/preview and /test: `language` leads the e-mail; `ar` / `en` are unsaved
    texts (a draft) applied over the saved ones, with the rules of PATCH. `scheme` is the design a preview
    shows (B13-5); a test e-mail is the e-mail as it is sent, with both designs, whatever it says."""

    language: Language
    scheme: EmailScheme = EmailScheme.LIGHT


class EmailPreviewDocumentQuery(QueryModel):
    """GET /email-templates/{kind}/preview: the language that leads the previewed e-mail, and the design
    the document shows (B13-5)."""

    language: Language
    scheme: EmailScheme = EmailScheme.LIGHT


class EmailPreview(ResponseModel):
    """The e-mail rendered with sample data (B11-28): the subject, the HTML document with its images as
    `data:` URIs (show it in a sandboxed frame) and the plain-text part."""

    kind: EditableEmailKind
    language: Language
    subject: str
    html: str
    text: str


class EmailTestSent(ResponseModel):
    """POST /email-templates/{kind}/test: the test e-mail went to the caller's own address."""

    sent_to: str
