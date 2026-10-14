"""A company's own e-mail texts (/api/v1/email-templates, Phase 11, B11-20 to B11-31): its
administrators only (ADMINISTER)."""

from typing import Annotated

from fastapi import APIRouter, BackgroundTasks, Query, status
from fastapi.responses import HTMLResponse

from app.api.deps import AdminAuth, ContextDep, DbSession, EmailDispatcherDep, EmailTemplatesServiceDep
from app.email.dispatcher import schedule_delivery
from app.schemas.email_templates import (
    EditableEmailKind,
    EmailPreview,
    EmailPreviewDocumentQuery,
    EmailTemplate,
    EmailTemplatePreviewRequest,
    EmailTemplateReset,
    EmailTemplateUpdate,
    EmailTestSent,
)
from app.services.email_templates import AdministratorEditor

router = APIRouter(prefix="/email-templates", tags=["email-templates"])

# The preview document's own policy (B11-28): nothing runs, nothing loads but its inline images and
# styles, links cannot navigate anything, and only the application's own pages may frame it.
PREVIEW_DOCUMENT_POLICY = (
    "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; "
    "frame-ancestors 'self'; sandbox"
)
PREVIEW_DOCUMENT_HEADERS = {
    "Content-Security-Policy": PREVIEW_DOCUMENT_POLICY,
    "X-Frame-Options": "SAMEORIGIN",
}


@router.get("", response_model=list[EmailTemplate])
def list_email_templates(auth: AdminAuth, service: EmailTemplatesServiceDep) -> list[EmailTemplate]:
    return service.list_templates(AdministratorEditor(auth))


@router.get("/{kind}", response_model=EmailTemplate)
def get_email_template(
    kind: EditableEmailKind, auth: AdminAuth, service: EmailTemplatesServiceDep
) -> EmailTemplate:
    return service.get_template(AdministratorEditor(auth), kind)


@router.patch("/{kind}", response_model=EmailTemplate)
def update_email_template(
    kind: EditableEmailKind,
    body: EmailTemplateUpdate,
    auth: AdminAuth,
    service: EmailTemplatesServiceDep,
    context: ContextDep,
) -> EmailTemplate:
    return service.update(AdministratorEditor(auth), kind, body.texts(), context)


@router.post("/{kind}/reset", response_model=EmailTemplate)
def reset_email_template(
    kind: EditableEmailKind,
    auth: AdminAuth,
    service: EmailTemplatesServiceDep,
    context: ContextDep,
    body: EmailTemplateReset | None = None,
) -> EmailTemplate:
    return service.reset(
        AdministratorEditor(auth), kind, body.language if body is not None else None, context
    )


@router.post("/{kind}/preview", response_model=EmailPreview)
def preview_email_template(
    kind: EditableEmailKind,
    body: EmailTemplatePreviewRequest,
    auth: AdminAuth,
    service: EmailTemplatesServiceDep,
) -> EmailPreview:
    return service.preview(AdministratorEditor(auth), kind, body.language, body.texts(), body.scheme)


@router.get("/{kind}/preview", response_class=HTMLResponse)
def email_template_preview_document(
    kind: EditableEmailKind,
    auth: AdminAuth,
    service: EmailTemplatesServiceDep,
    query: Annotated[EmailPreviewDocumentQuery, Query()],
) -> HTMLResponse:
    """The saved texts' HTML with sample data, as a document for a sandboxed frame of the application's own
    pages (the API's default policy forbids framing), in the design `scheme` asks for (B13-5)."""
    preview = service.preview(AdministratorEditor(auth), kind, query.language, scheme=query.scheme)
    return HTMLResponse(preview.html, headers=PREVIEW_DOCUMENT_HEADERS)


@router.post("/{kind}/test", response_model=EmailTestSent, status_code=status.HTTP_202_ACCEPTED)
def send_email_template_test(
    kind: EditableEmailKind,
    body: EmailTemplatePreviewRequest,
    auth: AdminAuth,
    service: EmailTemplatesServiceDep,
    db: DbSession,
    dispatcher: EmailDispatcherDep,
    background_tasks: BackgroundTasks,
    context: ContextDep,
) -> EmailTestSent:
    sent = service.test(AdministratorEditor(auth), kind, body.language, body.texts(), context)
    schedule_delivery(background_tasks, db, dispatcher, sent.job)
    return EmailTestSent(sent_to=sent.sent_to)
