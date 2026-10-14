"""A company's own wording of its e-mails (revision 0013, docs/decisions/phase-11-backend.md B11-20).

One row per (company, kind, language, field) that was ever edited. `text` is the company's text, or NULL
when the field is back on the product's text (the default from `app.email.i18n`): the runtime role
cannot delete rows (revision 0006), so "reset to default" clears the text instead.
"""

import uuid

from sqlalchemy import CheckConstraint, ForeignKey, ForeignKeyConstraint, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, TimestampMixin, UUIDPrimaryKeyMixin
from app.models.enums import EDITABLE_EMAIL_KINDS, Language, TemplateField, sql_in_list

# The longest text any field accepts (the service applies each field's own, smaller limit).
TEMPLATE_TEXT_MAX_LENGTH = 2000
_KINDS = ", ".join(f"'{kind.value}'" for kind in EDITABLE_EMAIL_KINDS)


class EmailTemplateOverride(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "email_template_overrides"
    __table_args__ = (
        UniqueConstraint("company_id", "kind", "language", "field"),
        ForeignKeyConstraint(
            ["company_id", "updated_by_id"], ["users.company_id", "users.id"], ondelete="RESTRICT"
        ),
        CheckConstraint(f"kind IN ({_KINDS})", name="kind_valid"),
        CheckConstraint(f"language IN ({sql_in_list(Language)})", name="language_valid"),
        CheckConstraint(f"field IN ({sql_in_list(TemplateField)})", name="field_valid"),
        CheckConstraint(
            f"text IS NULL OR (btrim(text) <> '' AND char_length(text) <= {TEMPLATE_TEXT_MAX_LENGTH})",
            name="text_valid",
        ),
    )

    company_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("companies.id", ondelete="RESTRICT"), nullable=False
    )
    kind: Mapped[str] = mapped_column(String(32), nullable=False)
    language: Mapped[str] = mapped_column(String(2), nullable=False)
    field: Mapped[str] = mapped_column(String(32), nullable=False)
    # The company's text, plain text with line breaks (`\n`); NULL: the product's text.
    text: Mapped[str | None] = mapped_column(Text)
    # The administrator who last changed it.
    updated_by_id: Mapped[uuid.UUID | None] = mapped_column()
