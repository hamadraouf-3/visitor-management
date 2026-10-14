"""The platform owner's API (/api/v1/platform, Phase 11, docs/decisions/phase-11-backend.md).

Authenticated by the platform session cookie only (`PlatformSessionAuth` / `PlatformAuth`); a tenant
session gets 401 here, and a platform session gets 401 on every tenant route. Unsafe requests need the
platform CSRF token in `X-CSRF-Token` (the CSRF middleware's platform realm), except the sign-in.

Phase 12 (docs/decisions/phase-12-backend.md): a company's identity (its logo, icon and colour, B12-7),
which only the platform owner sets, and a company's e-mail texts (B12-8), the endpoints of
/api/v1/email-templates for any company.
"""

import re
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, BackgroundTasks, Query, Request, Response, status
from fastapi.responses import HTMLResponse

from app.api.cookies import (
    clear_platform_session_cookies,
    set_platform_device_cookie,
    set_platform_session_cookies,
)
from app.api.deps import (
    ContextDep,
    DbSession,
    EmailDispatcherDep,
    EmailTemplatesServiceDep,
    PlatformAuth,
    PlatformAuthServiceDep,
    PlatformBrandServiceDep,
    PlatformCompaniesServiceDep,
    PlatformSessionAuth,
    PngUpload,
    SettingsDep,
)
from app.api.routes.email_templates import PREVIEW_DOCUMENT_HEADERS
from app.core.config import API_PREFIX
from app.core.palette import derive_palette
from app.email.dispatcher import schedule_deliveries, schedule_delivery
from app.models import BrandAssetKind, PlatformAdmin
from app.models.brand import BRAND_ASSET_MAX_BYTES
from app.schemas.auth import ChangePasswordRequest, LoginRequest, PreferencesUpdate
from app.schemas.brand import BrandPalette, BrandPaletteRequest, CompanyBrand, CompanyBrandUpdate
from app.schemas.common import Paginated
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
from app.schemas.platform import (
    AdminPasswordResetSent,
    CompanyAdminCreate,
    PlatformAdminProfile,
    PlatformAuditLog,
    PlatformAuditLogQuery,
    PlatformCompany,
    PlatformCompanyAdmin,
    PlatformCompanyCreate,
    PlatformCompanyCreated,
    PlatformCompanyListQuery,
    PlatformCompanyUpdate,
    PlatformMe,
)
from app.security.platform_sessions import platform_cookie_names
from app.services.email_templates import PlatformOwnerEditor

router = APIRouter(prefix="/platform", tags=["platform"])

# The one request whose body may exceed MAX_REQUEST_BODY_BYTES: the upload of a company's brand image
# (`BodySizeLimitMiddleware` in `app.main` gives exactly this method and path its own limit, the
# contract's 512 KiB). tests/unit/test_body_limit.py holds the pattern to the route below.
BRAND_IMAGE_UPLOAD_METHOD = "PUT"
BRAND_IMAGE_UPLOAD_PATH = re.compile(
    re.escape(f"{API_PREFIX}/platform/companies/") + "[^/]+/brand/assets/[^/]+"
)
BRAND_IMAGE_UPLOAD_MAX_BYTES = BRAND_ASSET_MAX_BYTES


def platform_me(admin: PlatformAdmin) -> PlatformMe:
    return PlatformMe(admin=PlatformAdminProfile.model_validate(admin))


# ---- sign-in -------------------------------------------------------------------------------------


@router.post("/auth/login", response_model=PlatformMe)
def platform_login(
    body: LoginRequest,
    request: Request,
    response: Response,
    service: PlatformAuthServiceDep,
    settings: SettingsDep,
    context: ContextDep,
) -> PlatformMe:
    names = platform_cookie_names(settings.cookie_secure)
    result = service.login(
        body.email,
        body.password,
        context,
        presented_session_token=request.cookies.get(names.session),
        device_cookie=request.cookies.get(names.device),
    )
    set_platform_session_cookies(response, settings, result.issued)
    set_platform_device_cookie(response, settings, result.device_cookie)
    return platform_me(result.admin)


@router.post("/auth/logout", status_code=status.HTTP_204_NO_CONTENT)
def platform_logout(
    auth: PlatformSessionAuth, service: PlatformAuthServiceDep, settings: SettingsDep, context: ContextDep
) -> Response:
    service.logout(auth, context)
    response = Response(status_code=status.HTTP_204_NO_CONTENT)
    clear_platform_session_cookies(response, settings)
    return response


@router.get("/auth/me", response_model=PlatformMe)
def platform_auth_me(auth: PlatformSessionAuth) -> PlatformMe:
    return platform_me(auth.admin)


@router.patch("/auth/preferences", response_model=PlatformMe)
def platform_preferences(
    body: PreferencesUpdate, auth: PlatformSessionAuth, service: PlatformAuthServiceDep
) -> PlatformMe:
    """Allowed while a password change is required, like the tenant's (B10-3)."""
    return platform_me(service.set_language(auth, body.language))


@router.post("/auth/change-password", status_code=status.HTTP_204_NO_CONTENT)
def platform_change_password(
    body: ChangePasswordRequest,
    request: Request,
    auth: PlatformSessionAuth,
    service: PlatformAuthServiceDep,
    settings: SettingsDep,
    context: ContextDep,
) -> Response:
    device = request.cookies.get(platform_cookie_names(settings.cookie_secure).device)
    changed = service.change_password(
        auth, body.current_password, body.new_password, context, device_cookie=device
    )
    # The session is replaced (SEC-04): the 204 carries the new platform session and CSRF cookies.
    response = Response(status_code=status.HTTP_204_NO_CONTENT)
    set_platform_session_cookies(response, settings, changed.session)
    set_platform_device_cookie(response, settings, changed.device_cookie)
    return response


# ---- companies -----------------------------------------------------------------------------------


@router.get("/companies", response_model=Paginated[PlatformCompany])
def list_platform_companies(
    auth: PlatformAuth,
    service: PlatformCompaniesServiceDep,
    query: Annotated[PlatformCompanyListQuery, Query()],
) -> Paginated[PlatformCompany]:
    page = service.list_companies(query)
    return Paginated[PlatformCompany](
        items=page.items, page=page.page, page_size=page.page_size, total=page.total
    )


@router.post("/companies", response_model=PlatformCompanyCreated, status_code=status.HTTP_201_CREATED)
def create_platform_company(
    body: PlatformCompanyCreate,
    auth: PlatformAuth,
    service: PlatformCompaniesServiceDep,
    context: ContextDep,
) -> PlatformCompanyCreated:
    company, admin = service.create_company(auth, body, context)
    return PlatformCompanyCreated(company=company, admin=PlatformCompanyAdmin.model_validate(admin))


@router.get("/companies/{company_id}", response_model=PlatformCompany)
def get_platform_company(
    company_id: UUID, auth: PlatformAuth, service: PlatformCompaniesServiceDep
) -> PlatformCompany:
    return service.get_company(company_id)


@router.patch("/companies/{company_id}", response_model=PlatformCompany)
def update_platform_company(
    company_id: UUID,
    body: PlatformCompanyUpdate,
    auth: PlatformAuth,
    service: PlatformCompaniesServiceDep,
    context: ContextDep,
) -> PlatformCompany:
    return service.update_company(auth, company_id, body, context)


@router.post("/companies/{company_id}/deactivate", response_model=PlatformCompany)
def deactivate_platform_company(
    company_id: UUID, auth: PlatformAuth, service: PlatformCompaniesServiceDep, context: ContextDep
) -> PlatformCompany:
    return service.set_active(auth, company_id, False, context)


@router.post("/companies/{company_id}/reactivate", response_model=PlatformCompany)
def reactivate_platform_company(
    company_id: UUID, auth: PlatformAuth, service: PlatformCompaniesServiceDep, context: ContextDep
) -> PlatformCompany:
    return service.set_active(auth, company_id, True, context)


@router.get("/companies/{company_id}/admins", response_model=list[PlatformCompanyAdmin])
def list_platform_company_admins(
    company_id: UUID, auth: PlatformAuth, service: PlatformCompaniesServiceDep
) -> list[PlatformCompanyAdmin]:
    return [PlatformCompanyAdmin.model_validate(user) for user in service.list_admins(company_id)]


@router.post(
    "/companies/{company_id}/admins",
    response_model=PlatformCompanyAdmin,
    status_code=status.HTTP_201_CREATED,
)
def create_platform_company_admin(
    company_id: UUID,
    body: CompanyAdminCreate,
    auth: PlatformAuth,
    service: PlatformCompaniesServiceDep,
    db: DbSession,
    dispatcher: EmailDispatcherDep,
    background_tasks: BackgroundTasks,
    context: ContextDep,
) -> PlatformCompanyAdmin:
    user, notices = service.create_admin(auth, company_id, body, context)
    # The company's other administrators are told (B11-43), after the commit.
    schedule_deliveries(background_tasks, db, dispatcher, notices)
    return PlatformCompanyAdmin.model_validate(user)


@router.post(
    "/companies/{company_id}/admins/{user_id}/password-reset",
    response_model=AdminPasswordResetSent,
    status_code=status.HTTP_202_ACCEPTED,
)
def send_platform_admin_password_reset(
    company_id: UUID,
    user_id: UUID,
    auth: PlatformAuth,
    service: PlatformCompaniesServiceDep,
    db: DbSession,
    dispatcher: EmailDispatcherDep,
    background_tasks: BackgroundTasks,
    context: ContextDep,
) -> AdminPasswordResetSent:
    # The reset link, and the notices to the company's other administrators (B11-43).
    user, jobs = service.send_admin_reset(auth, company_id, user_id, context)
    schedule_deliveries(background_tasks, db, dispatcher, jobs)
    return AdminPasswordResetSent(sent_to=user.email)


# ---- a company's identity (B12-7) ------------------------------------------------------------------
# Only here can a brand change: no endpoint of a company's own users takes a logo, an icon or a colour.


@router.get("/companies/{company_id}/brand", response_model=CompanyBrand)
def get_platform_company_brand(
    company_id: UUID, auth: PlatformAuth, service: PlatformBrandServiceDep
) -> CompanyBrand:
    return service.get(company_id)


@router.patch("/companies/{company_id}/brand", response_model=CompanyBrand)
def update_platform_company_brand(
    company_id: UUID,
    body: CompanyBrandUpdate,
    auth: PlatformAuth,
    service: PlatformBrandServiceDep,
    context: ContextDep,
) -> CompanyBrand:
    """The company's colour (`#rrggbb`), or null for the product's palette."""
    return service.set_color(auth, company_id, body.color, context)


@router.put(
    "/companies/{company_id}/brand/assets/{kind}",
    response_model=CompanyBrand,
    openapi_extra={
        "requestBody": {
            "required": True,
            "content": {"image/png": {"schema": {"type": "string", "format": "binary"}}},
        }
    },
)
def put_platform_company_brand_image(
    company_id: UUID,
    kind: BrandAssetKind,
    auth: PlatformAuth,
    upload: PngUpload,
    service: PlatformBrandServiceDep,
    context: ContextDep,
) -> CompanyBrand:
    """Store the company's logo, dark-surface logo or icon. The body is the PNG itself (`Content-Type:
    image/png`, at most 512 KiB); it is checked and written again by the server before it is stored."""
    return service.put_image(auth, company_id, kind, upload, context)


@router.delete("/companies/{company_id}/brand/assets/{kind}", response_model=CompanyBrand)
def delete_platform_company_brand_image(
    company_id: UUID,
    kind: BrandAssetKind,
    auth: PlatformAuth,
    service: PlatformBrandServiceDep,
    context: ContextDep,
) -> CompanyBrand:
    return service.remove_image(auth, company_id, kind, context)


@router.post("/brand/palette", response_model=BrandPalette)
def preview_platform_brand_palette(body: BrandPaletteRequest, auth: PlatformAuth) -> BrandPalette:
    """The palette a colour would give a company. Nothing is saved and no company is named."""
    return BrandPalette(**derive_palette(body.color).as_dict())


# ---- a company's e-mail texts (B12-8) ----------------------------------------------------------------
# The endpoints of /api/v1/email-templates, for the company in the path: the same service, the same
# texts, checks, limits and answers (`services.email_templates`). A test e-mail goes to the platform
# owner's own address; the preview's sample host is a sample name.


@router.get("/companies/{company_id}/email-templates", response_model=list[EmailTemplate])
def list_platform_company_email_templates(
    company_id: UUID, auth: PlatformAuth, service: EmailTemplatesServiceDep
) -> list[EmailTemplate]:
    return service.list_templates(PlatformOwnerEditor(auth, company_id))


@router.get("/companies/{company_id}/email-templates/{kind}", response_model=EmailTemplate)
def get_platform_company_email_template(
    company_id: UUID, kind: EditableEmailKind, auth: PlatformAuth, service: EmailTemplatesServiceDep
) -> EmailTemplate:
    return service.get_template(PlatformOwnerEditor(auth, company_id), kind)


@router.patch("/companies/{company_id}/email-templates/{kind}", response_model=EmailTemplate)
def update_platform_company_email_template(
    company_id: UUID,
    kind: EditableEmailKind,
    body: EmailTemplateUpdate,
    auth: PlatformAuth,
    service: EmailTemplatesServiceDep,
    context: ContextDep,
) -> EmailTemplate:
    return service.update(PlatformOwnerEditor(auth, company_id), kind, body.texts(), context)


@router.post("/companies/{company_id}/email-templates/{kind}/reset", response_model=EmailTemplate)
def reset_platform_company_email_template(
    company_id: UUID,
    kind: EditableEmailKind,
    auth: PlatformAuth,
    service: EmailTemplatesServiceDep,
    context: ContextDep,
    body: EmailTemplateReset | None = None,
) -> EmailTemplate:
    language = body.language if body is not None else None
    return service.reset(PlatformOwnerEditor(auth, company_id), kind, language, context)


@router.post("/companies/{company_id}/email-templates/{kind}/preview", response_model=EmailPreview)
def preview_platform_company_email_template(
    company_id: UUID,
    kind: EditableEmailKind,
    body: EmailTemplatePreviewRequest,
    auth: PlatformAuth,
    service: EmailTemplatesServiceDep,
) -> EmailPreview:
    return service.preview(
        PlatformOwnerEditor(auth, company_id), kind, body.language, body.texts(), body.scheme
    )


@router.get("/companies/{company_id}/email-templates/{kind}/preview", response_class=HTMLResponse)
def platform_company_email_template_preview_document(
    company_id: UUID,
    kind: EditableEmailKind,
    auth: PlatformAuth,
    service: EmailTemplatesServiceDep,
    query: Annotated[EmailPreviewDocumentQuery, Query()],
) -> HTMLResponse:
    """The saved texts' HTML with sample data, as a document for a sandboxed frame of the platform's own
    pages (as GET /email-templates/{kind}/preview for a company's), in the design `scheme` asks for."""
    preview = service.preview(
        PlatformOwnerEditor(auth, company_id), kind, query.language, scheme=query.scheme
    )
    return HTMLResponse(preview.html, headers=PREVIEW_DOCUMENT_HEADERS)


@router.post(
    "/companies/{company_id}/email-templates/{kind}/test",
    response_model=EmailTestSent,
    status_code=status.HTTP_202_ACCEPTED,
)
def send_platform_company_email_template_test(
    company_id: UUID,
    kind: EditableEmailKind,
    body: EmailTemplatePreviewRequest,
    auth: PlatformAuth,
    service: EmailTemplatesServiceDep,
    db: DbSession,
    dispatcher: EmailDispatcherDep,
    background_tasks: BackgroundTasks,
    context: ContextDep,
) -> EmailTestSent:
    editor = PlatformOwnerEditor(auth, company_id)
    sent = service.test(editor, kind, body.language, body.texts(), context)
    schedule_delivery(background_tasks, db, dispatcher, sent.job)
    return EmailTestSent(sent_to=sent.sent_to)


# ---- the platform's audit trail -------------------------------------------------------------------


@router.get("/audit-logs", response_model=Paginated[PlatformAuditLog])
def list_platform_audit_logs(
    auth: PlatformAuth,
    service: PlatformCompaniesServiceDep,
    query: Annotated[PlatformAuditLogQuery, Query()],
) -> Paginated[PlatformAuditLog]:
    page = service.audit_logs(query)
    return Paginated[PlatformAuditLog](
        items=page.items, page=page.page, page_size=page.page_size, total=page.total
    )
