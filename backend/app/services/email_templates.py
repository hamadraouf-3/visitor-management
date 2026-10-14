"""A company's own e-mail texts: list, read, change, reset, preview and test (Phase 11, B11-20 to B11-31).

Two kinds of editor reach this one service, with the same texts, checks and limits (`TemplateEditor`):

* the company's own administrators (ADMINISTER), through /api/v1/email-templates: `AdministratorEditor`;
* the **platform owner**, for any company, through /api/v1/platform/companies/{id}/email-templates
  (Phase 12, B12-8): `PlatformOwnerEditor`.

What differs between them is who they are, not what they may write: which company (the session's, or the
one named in the path), how the company row is locked and the caller re-checked before a write (SEC-07 for
an administrator, B11-38 for the platform owner), where the change is audited (the company's trail with
the administrator as actor; or both trails, B11-5), whose address a test e-mail goes to (always the
editor's own) and whose name the sample visit's host has (an administrator's own; a sample name for the
platform owner, who hosts nobody).

* Texts are validated field by field (`app.email.editable.check_text`); every problem is a 422 field error
  at `ar.<field>` / `en.<field>` with its field code. A field a kind does not have is `not_allowed`.
  Null or blank text returns the field to the product's text.
* Changes are audited as EMAIL_TEMPLATE_UPDATED with the kind and the names of the changed and reset
  fields (`ar.subject`, `en.intro`), never the texts (B11-30, contract §3.2-8: no free text in audit
  metadata); a reset as EMAIL_TEMPLATE_RESET.
* A preview renders the kind with sample data (a sample visitor, the editor as the host, tomorrow at
  10:00 in the company's time zone, a sample QR code that is not a pass) and the saved texts, or a draft
  over them, without sending anything (B11-28). It shows the company's own identity, as its e-mails do
  (B12-12), in the one design asked for (Phase 13, B13-5): `light` or `dark`, as a mail client in that
  scheme shows it, whatever the scheme of the device the preview is looked at on. A test e-mail is the
  e-mail as it is sent, with both designs.
* A test sends that rendering to the editor's own address only, with "[Test] " before the subject
    («[رسالة تجريبية] » when Arabic leads; the subject is built for the room the prefix leaves, B12-24),
  within RATE_LIMIT_TEMPLATE_TEST_SENDS_PER_HOUR (B11-29); audited as EMAIL_TEMPLATE_TEST_SENT.
"""

import base64
import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime, time, timedelta
from typing import Protocol
from zoneinfo import ZoneInfo

from sqlalchemy.orm import Session

from app.core import time as app_time
from app.core.config import Settings
from app.core.errors import NotFound, RateLimited, ValidationFailed
from app.core.field_errors import FieldCode, FieldProblem
from app.core.rate_limit import RateLimiter, RatePolicies
from app.core.request_context import RequestContext
from app.email.editable import (
    EDITABLE,
    MAX_VARIABLE_USES,
    EditableKind,
    Texts,
    check_text,
    default_text,
    normalise_text,
)
from app.email.rendering import Scheme
from app.email.service import (
    TEST_EMAIL_SAMPLE_FRAGMENT,
    TEST_SUBJECT_PREFIX,
    DeliveryJob,
    EmailService,
    PreparedEmail,
)
from app.models import Company, EmailKind, Language, TemplateField, Visit
from app.repositories.companies import CompanyRepository
from app.repositories.email_templates import EmailTemplateOverrideRepository, TemplateTexts
from app.repositories.locking import RowLock
from app.schemas.email_templates import (
    EditableEmailKind,
    EmailPreview,
    EmailScheme,
    EmailTemplate,
    EmailTemplateField,
    EmailTemplateTexts,
    LanguageTexts,
    OptionalLanguageTexts,
)
from app.security.platform_sessions import PlatformAuthContext
from app.security.sessions import AuthContext
from app.security.tokens import build_pass_url
from app.services import audit
from app.services.audit import AuditAction, AuditEntity
from app.services.authorization import lock_company_for_change, require_platform_still_authorized
from app.services.scoping import require_found

LANGUAGES = (Language.AR, Language.EN)
NOT_EDITABLE = FieldProblem(FieldCode.NOT_ALLOWED, "This e-mail has no such text.")
# The sample visit of a preview: tomorrow at this local time, for an hour.
SAMPLE_START = time(10, 0)
SAMPLE_VISITOR = {Language.AR: "سارة أحمد", Language.EN: "Sara Ahmad"}
SAMPLE_VISITOR_COMPANY = {Language.AR: "شركة المثال للتجارة", Language.EN: "Example Trading"}
SAMPLE_PURPOSE = {Language.AR: "اجتماع إطلاق المشروع", Language.EN: "Project kickoff meeting"}
SAMPLE_DEPARTMENT = {Language.AR: "المالية", Language.EN: "Finance"}
SAMPLE_REASON = {Language.AR: "تغيّر جدول الاجتماعات", Language.EN: "The meeting schedule changed"}
# The sample visit's host when the editor hosts nobody (the platform owner, B12-8).
SAMPLE_HOST = {Language.AR: "عمر خليل", Language.EN: "Omar Khalil"}

# A draft or a change: language -> field -> text (None: back to the product's text).
type TextChanges = dict[Language, dict[TemplateField, str | None]]


@dataclass(frozen=True, slots=True)
class SampleHost:
    """Who hosts a preview's sample visit: their name, the address a visitor's reply would reach, and
    their department's names (English or only, Arabic), if they have one."""

    full_name: str
    email: str
    department: tuple[str, str | None] | None


class TemplateEditor(Protocol):
    """Who reads and changes a company's e-mail texts (see the module)."""

    @property
    def company_id(self) -> uuid.UUID: ...

    @property
    def updated_by_id(self) -> uuid.UUID | None:
        """The company's user recorded beside a changed text (`email_template_overrides.updated_by_id`)."""
        ...

    @property
    def recipient(self) -> str:
        """Where a test e-mail goes: the editor's own address."""
        ...

    @property
    def recipient_user_id(self) -> uuid.UUID | None: ...

    @property
    def test_budget_key(self) -> str:
        """The key of the editor's hourly budget of test e-mails."""
        ...

    def company(self, db: Session) -> Company:
        """The company whose texts these are, or 404."""
        ...

    def lock_company(self, db: Session) -> Company:
        """The first step of a write: the company row locked `FOR KEY SHARE` and the editor re-checked."""
        ...

    def sample_host(self, language: Language) -> SampleHost: ...

    def record(
        self, db: Session, action: AuditAction, context: RequestContext, metadata: Mapping[str, object]
    ) -> None:
        """Audit a change of the company's texts in the caller's transaction."""
        ...


@dataclass(frozen=True, slots=True)
class AdministratorEditor:
    """One of the company's own administrators (B11-31)."""

    auth: AuthContext

    @property
    def company_id(self) -> uuid.UUID:
        return self.auth.company_id

    @property
    def updated_by_id(self) -> uuid.UUID | None:
        return self.auth.user_id

    @property
    def recipient(self) -> str:
        return self.auth.user.email

    @property
    def recipient_user_id(self) -> uuid.UUID | None:
        return self.auth.user_id

    @property
    def test_budget_key(self) -> str:
        return str(self.auth.user_id)

    def company(self, db: Session) -> Company:
        return self.auth.user.company

    def lock_company(self, db: Session) -> Company:
        return lock_company_for_change(db, self.auth, lock=RowLock.KEY_SHARE)

    def sample_host(self, language: Language) -> SampleHost:
        user = self.auth.user
        department = user.department
        return SampleHost(
            full_name=user.full_name,
            email=user.email,
            department=(department.name, department.name_ar) if department else None,
        )

    def record(
        self, db: Session, action: AuditAction, context: RequestContext, metadata: Mapping[str, object]
    ) -> None:
        audit.record(
            db,
            action=action,
            context=context,
            company_id=self.auth.company_id,
            actor_user_id=self.auth.user_id,
            entity_type=AuditEntity.EMAIL_TEMPLATE,
            metadata=metadata,
        )


@dataclass(frozen=True, slots=True)
class PlatformOwnerEditor:
    """The platform owner, for the company named in the request's path (B12-8). The texts are the
    company's: what it saves is what the company's administrators see and may change again."""

    auth: PlatformAuthContext
    company_id: uuid.UUID

    @property
    def updated_by_id(self) -> uuid.UUID | None:
        return None  # no user of the company made the change; the audit rows say who did

    @property
    def recipient(self) -> str:
        return self.auth.admin.email

    @property
    def recipient_user_id(self) -> uuid.UUID | None:
        return None

    @property
    def test_budget_key(self) -> str:
        return f"platform:{self.auth.platform_admin_id}"

    def company(self, db: Session) -> Company:
        return require_found(CompanyRepository(db).get(self.company_id))

    def lock_company(self, db: Session) -> Company:
        # As every platform write (B11-38): the row first, then the caller again, then whether the
        # company exists, so an ended session answers 401 whatever the path names.
        company = CompanyRepository(db).get(self.company_id, lock=RowLock.KEY_SHARE)
        require_platform_still_authorized(db, self.auth, now=app_time.now())
        return require_found(company)

    def sample_host(self, language: Language) -> SampleHost:
        # A reply to a test e-mail reaches the person who sent it, as an administrator's does.
        return SampleHost(full_name=SAMPLE_HOST[language], email=self.auth.admin.email, department=None)

    def record(
        self, db: Session, action: AuditAction, context: RequestContext, metadata: Mapping[str, object]
    ) -> None:
        audit.record_platform_change(
            db,
            action=action,
            context=context,
            platform_admin_id=self.auth.platform_admin_id,
            company_id=self.company_id,
            entity_type=AuditEntity.EMAIL_TEMPLATE,
            entity_id=None,
            metadata=metadata,
        )


def _kind(kind: EditableEmailKind) -> EditableKind:
    return EDITABLE[EmailKind(kind.value)]


def _changes(
    spec: EditableKind, texts: Mapping[Language, EmailTemplateTexts | None], *, path: str = ""
) -> TextChanges:
    """The submitted texts, normalised and checked; every problem is a 422 field error at
    `<path><language>.<field>`."""
    problems: dict[str, FieldProblem] = {}
    changes: TextChanges = {}
    for language, submitted in texts.items():
        if submitted is None:
            continue
        for name in submitted.model_fields_set:
            field = TemplateField(name)
            location = f"{path}{language.value}.{field.value}"
            definition = spec.field(field)
            if definition is None:
                problems[location] = NOT_EDITABLE
                continue
            value = getattr(submitted, name)
            text = normalise_text(value) if value is not None else ""
            if not text:
                changes.setdefault(language, {})[field] = None
                continue
            problem = check_text(definition, spec, text)
            if problem is not None:
                problems[location] = problem
            else:
                changes.setdefault(language, {})[field] = text
    if problems:
        raise ValidationFailed(problems)
    return changes


def _applied(saved: TemplateTexts, changes: TextChanges) -> Texts:
    """The saved texts with a draft applied over them."""
    texts: dict[Language, dict[str, str]] = {
        language: dict(saved.get(language, {})) for language in LANGUAGES
    }
    for language, fields in changes.items():
        for field, text in fields.items():
            if text is None:
                texts[language].pop(field.value, None)
            else:
                texts[language][field.value] = text
    return texts


def inline_images_as_data(prepared: PreparedEmail) -> str:
    """The HTML with every inline image as a `data:` URI, so the document needs nothing else to show.

    Only an image's own `src="cid:…"` attribute is replaced, exactly as the templates write it. A
    company's text that merely contains the words `cid:visitor-pass-qr` stays as typed: text is escaped
    when it is rendered (a typed `"` is `&#34;`), so it can never form that attribute."""
    html = prepared.rendered.html
    for image in prepared.inline_images:
        data = base64.b64encode(image.content).decode("ascii")
        html = html.replace(f'src="cid:{image.content_id}"', f'src="data:{image.mime_type};base64,{data}"')
    return html


@dataclass(frozen=True, slots=True)
class TestSend:
    sent_to: str
    job: DeliveryJob


class EmailTemplatesService:
    def __init__(
        self,
        db: Session,
        *,
        settings: Settings,
        emails: EmailService,
        limiter: RateLimiter,
        policies: RatePolicies,
    ) -> None:
        self.db = db
        self.settings = settings
        self.emails = emails
        self.limiter = limiter
        self.policies = policies
        self.overrides = EmailTemplateOverrideRepository(db)

    # ---- reads ----------------------------------------------------------------------------------

    def list_templates(self, editor: TemplateEditor) -> list[EmailTemplate]:
        company = editor.company(self.db)
        texts = self.overrides.all_texts(company.id)
        changed = self.overrides.last_changes(company.id)
        return [
            self._view(EditableEmailKind(kind.value), texts.get(kind.value, {}), changed.get(kind.value))
            for kind in EDITABLE
        ]

    def get_template(self, editor: TemplateEditor, kind: EditableEmailKind) -> EmailTemplate:
        company = editor.company(self.db)
        return self._view(
            kind,
            self.overrides.texts(company.id, kind.value),
            self.overrides.last_changes(company.id).get(kind.value),
        )

    @staticmethod
    def _view(kind: EditableEmailKind, texts: TemplateTexts, updated_at: datetime | None) -> EmailTemplate:
        spec = _kind(kind)
        return EmailTemplate(
            kind=kind,
            variables=list(spec.variables),
            max_variable_uses=MAX_VARIABLE_USES,
            fields=[
                EmailTemplateField(
                    name=field.name,
                    multiline=field.multiline,
                    max_length=field.max_length,
                    required_variables=list(field.required),
                    forbidden_variables=list(field.forbidden),
                    default=LanguageTexts(
                        ar=default_text(field, Language.AR), en=default_text(field, Language.EN)
                    ),
                    override=OptionalLanguageTexts(
                        ar=texts.get(Language.AR, {}).get(field.name.value),
                        en=texts.get(Language.EN, {}).get(field.name.value),
                    ),
                )
                for field in spec.fields
            ],
            updated_at=updated_at,
        )

    # ---- writes ---------------------------------------------------------------------------------

    def update(
        self,
        editor: TemplateEditor,
        kind: EditableEmailKind,
        texts: Mapping[Language, EmailTemplateTexts | None],
        context: RequestContext,
    ) -> EmailTemplate:
        changes = _changes(_kind(kind), texts)
        company = editor.lock_company(self.db)
        saved = self.overrides.texts(company.id, kind.value)
        now = app_time.now()
        changed: list[str] = []
        reset: list[str] = []
        for language, fields in changes.items():
            for field, text in fields.items():
                current = saved.get(language, {}).get(field.value)
                if text == current:
                    continue
                self.overrides.put(
                    company.id,
                    EmailKind(kind.value),
                    language,
                    field.value,
                    text,
                    actor_id=editor.updated_by_id,
                    now=now,
                )
                (changed if text is not None else reset).append(f"{language.value}.{field.value}")
        if changed or reset:
            editor.record(
                self.db,
                AuditAction.EMAIL_TEMPLATE_UPDATED,
                context,
                {"kind": kind, "changed": sorted(changed), "reset": sorted(reset)},
            )
            self.db.commit()
        return self.get_template(editor, kind)

    def reset(
        self,
        editor: TemplateEditor,
        kind: EditableEmailKind,
        language: Language | None,
        context: RequestContext,
    ) -> EmailTemplate:
        company = editor.lock_company(self.db)
        saved = self.overrides.texts(company.id, kind.value)
        now = app_time.now()
        reset: list[str] = []
        for lang in (language,) if language is not None else LANGUAGES:
            for field in sorted(saved.get(lang, {})):
                self.overrides.put(
                    company.id,
                    EmailKind(kind.value),
                    lang,
                    field,
                    None,
                    actor_id=editor.updated_by_id,
                    now=now,
                )
                reset.append(f"{lang.value}.{field}")
        if reset:
            editor.record(
                self.db, AuditAction.EMAIL_TEMPLATE_RESET, context, {"kind": kind, "reset": sorted(reset)}
            )
            self.db.commit()
        return self.get_template(editor, kind)

    # ---- preview and test -----------------------------------------------------------------------

    def preview(
        self,
        editor: TemplateEditor,
        kind: EditableEmailKind,
        language: Language,
        draft: Mapping[Language, EmailTemplateTexts | None] | None = None,
        scheme: EmailScheme = EmailScheme.LIGHT,
    ) -> EmailPreview:
        prepared = self._prepare(editor, kind, language, draft, scheme=scheme)
        return EmailPreview(
            kind=kind,
            language=language,
            subject=prepared.rendered.subject,
            html=inline_images_as_data(prepared),
            text=prepared.rendered.text,
        )

    def test(
        self,
        editor: TemplateEditor,
        kind: EditableEmailKind,
        language: Language,
        draft: Mapping[Language, EmailTemplateTexts | None],
        context: RequestContext,
    ) -> TestSend:
        prepared = self._prepare(editor, kind, language, draft, subject_prefix=TEST_SUBJECT_PREFIX[language])
        policy = self.policies.template_test_sends_per_user
        decision = self.limiter.hit(policy, editor.test_budget_key)
        if not decision.allowed:
            raise RateLimited(retry_after=decision.retry_after, policy=policy.name)
        company = editor.lock_company(self.db)
        recipient = editor.recipient
        job = self.emails.queue_prepared(
            prepared,
            company_id=company.id,
            to=recipient,
            recipient_user_id=editor.recipient_user_id,
        )
        editor.record(
            self.db,
            AuditAction.EMAIL_TEMPLATE_TEST_SENT,
            context,
            {
                "kind": kind,
                "language": language,
                "email_message_id": job.message_id,
                "draft": any(texts is not None for texts in (draft or {}).values()),
            },
        )
        self.db.commit()
        return TestSend(sent_to=recipient, job=job)

    def _prepare(
        self,
        editor: TemplateEditor,
        kind: EditableEmailKind,
        language: Language,
        draft: Mapping[Language, EmailTemplateTexts | None] | None,
        *,
        subject_prefix: str = "",
        scheme: EmailScheme | None = None,
    ) -> PreparedEmail:
        """The rendered e-mail: as it is sent (a test e-mail), or one design alone (a preview)."""
        spec = _kind(kind)
        design: Scheme | None = None if scheme is None else scheme.value
        company = editor.company(self.db)
        changes = _changes(spec, draft or {})
        saved = self.overrides.texts(company.id, kind.value)
        texts = _applied(saved, changes)
        # The company as it is (its identity included, B12-12), leading with the previewed language.
        sample_company = Company(
            id=company.id,
            name=company.name,
            name_ar=company.name_ar,
            slug=company.slug,
            timezone=company.timezone,
            address=company.address,
            address_ar=company.address_ar,
            notify_host_on_check_in=company.notify_host_on_check_in,
            default_language=language.value,
            brand_color=company.brand_color,
        )
        host = editor.sample_host(language)
        visit = self._sample_visit(company, host, language)
        # The address a real invitation of this company carries, with a fragment that is no pass.
        pass_url = build_pass_url(self.settings.pass_url_base, TEST_EMAIL_SAMPLE_FRAGMENT, company.slug)
        match spec.kind:
            case EmailKind.VISITOR_INVITATION:
                return self.emails.prepare_visitor_invitation(
                    visit,
                    pass_url,
                    company=sample_company,
                    host_email=host.email,
                    overrides=texts,
                    subject_prefix=subject_prefix,
                    scheme=design,
                )
            case EmailKind.VISIT_RESCHEDULED:
                return self.emails.prepare_visit_rescheduled(
                    visit,
                    company=sample_company,
                    host_email=host.email,
                    overrides=texts,
                    subject_prefix=subject_prefix,
                    scheme=design,
                )
            case EmailKind.VISIT_CANCELLED:
                return self.emails.prepare_visit_cancelled(
                    visit,
                    SAMPLE_REASON[language],
                    company=sample_company,
                    host_email=host.email,
                    overrides=texts,
                    subject_prefix=subject_prefix,
                    scheme=design,
                )
            case EmailKind.HOST_ARRIVAL:
                return self.emails.prepare_host_arrival(
                    visit,
                    company=sample_company,
                    host_name=host.full_name,
                    host_language=language.value,
                    overrides=texts,
                    subject_prefix=subject_prefix,
                    scheme=design,
                )
        raise NotFound()  # pragma: no cover - every editable kind is matched above

    @staticmethod
    def _sample_visit(company: Company, host: SampleHost, language: Language) -> Visit:
        """A visit that exists nowhere: tomorrow at 10:00 in the company's time zone, hosted by the
        editor (their own department when they have one), with a sample visitor (B11-28)."""
        zone = ZoneInfo(company.timezone)
        tomorrow = app_time.now().astimezone(zone).date() + timedelta(days=1)
        start = datetime.combine(tomorrow, SAMPLE_START, tzinfo=zone)
        end = start + timedelta(hours=1)
        department = host.department or (SAMPLE_DEPARTMENT[Language.EN], SAMPLE_DEPARTMENT[Language.AR])
        host_id = uuid.uuid4()
        return Visit(
            id=uuid.uuid4(),
            company_id=company.id,
            visitor_id=uuid.uuid4(),
            host_id=host_id,
            created_by_id=host_id,
            visitor_name=SAMPLE_VISITOR[language],
            visitor_company_name=SAMPLE_VISITOR_COMPANY[language],
            host_name=host.full_name,
            department_name=department[0],
            department_name_ar=department[1],
            purpose=SAMPLE_PURPOSE[language],
            scheduled_start=start,
            scheduled_end=end,
            window_start=start - timedelta(minutes=company.pass_grace_before_minutes),
            window_end=end + timedelta(minutes=company.pass_grace_after_minutes),
            check_in_at=start + timedelta(minutes=5),
        )
