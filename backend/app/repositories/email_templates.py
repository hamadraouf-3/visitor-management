"""A company's own e-mail texts (revision 0013, B11-20). Every query is scoped by company."""

from datetime import datetime
from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app.models import EmailKind, EmailTemplateOverride, Language

# language -> field -> text (only the fields that have a company text)
type TemplateTexts = dict[Language, dict[str, str]]


class EmailTemplateOverrideRepository:
    def __init__(self, db: Session) -> None:
        self.db = db

    def texts(self, company_id: UUID, kind: EmailKind | str) -> TemplateTexts:
        """The company's texts of `kind` that replace the product's (rows whose text is NULL are back on
        the product's text and left out)."""
        statement = select(
            EmailTemplateOverride.language, EmailTemplateOverride.field, EmailTemplateOverride.text
        ).where(
            EmailTemplateOverride.company_id == company_id,
            EmailTemplateOverride.kind == str(kind),
            EmailTemplateOverride.text.is_not(None),
        )
        texts: TemplateTexts = {}
        for language, field, text in self.db.execute(statement):
            if text is not None:
                texts.setdefault(Language(language), {})[field] = text
        return texts

    def all_texts(self, company_id: UUID) -> dict[str, TemplateTexts]:
        """`texts` of every kind: kind -> language -> field -> text."""
        statement = select(
            EmailTemplateOverride.kind,
            EmailTemplateOverride.language,
            EmailTemplateOverride.field,
            EmailTemplateOverride.text,
        ).where(EmailTemplateOverride.company_id == company_id, EmailTemplateOverride.text.is_not(None))
        texts: dict[str, TemplateTexts] = {}
        for kind, language, field, text in self.db.execute(statement):
            if text is not None:
                texts.setdefault(kind, {}).setdefault(Language(language), {})[field] = text
        return texts

    def last_changes(self, company_id: UUID) -> dict[str, datetime]:
        """When each kind's texts last changed (set or reset), for kinds that were ever edited."""
        statement = (
            select(EmailTemplateOverride.kind, func.max(EmailTemplateOverride.updated_at))
            .where(EmailTemplateOverride.company_id == company_id)
            .group_by(EmailTemplateOverride.kind)
        )
        return {row[0]: row[1] for row in self.db.execute(statement)}

    def put(
        self,
        company_id: UUID,
        kind: EmailKind,
        language: Language,
        field: str,
        text: str | None,
        *,
        actor_id: UUID | None,
        now: datetime,
    ) -> None:
        """Set (or, with None, clear) one text: one row per (company, kind, language, field), inserted the
        first time and updated afterwards (the runtime role cannot delete). `actor_id` is the company's
        user who made the change; None when the platform owner did (B12-8: the audit rows say who)."""
        statement = insert(EmailTemplateOverride).values(
            company_id=company_id,
            kind=kind.value,
            language=language.value,
            field=field,
            text=text,
            updated_by_id=actor_id,
            created_at=now,
            updated_at=now,
        )
        self.db.execute(
            statement.on_conflict_do_update(
                constraint="uq_email_template_overrides_company_id_kind_language_field",
                set_={"text": text, "updated_by_id": actor_id, "updated_at": now},
            )
        )
