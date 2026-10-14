from fastapi import APIRouter, BackgroundTasks, Request, Response, status

from app.api.cookies import clear_session_cookies, set_device_cookie, set_session_cookies
from app.api.deps import (
    AuthServiceDep,
    BrandReaderDep,
    ContextDep,
    DbSession,
    EmailDispatcherDep,
    PasswordResetIssuerDep,
    PreferencesServiceDep,
    SessionAuth,
    SettingsDep,
)
from app.email.dispatcher import schedule_delivery
from app.models import Language, User
from app.schemas.auth import (
    ChangePasswordRequest,
    ForgotPasswordRequest,
    ForgotPasswordResponse,
    LoginRequest,
    Me,
    MeCompany,
    MeUser,
    PreferencesUpdate,
    ResetPasswordRequest,
)
from app.security.sessions import cookie_names
from app.services.auth import RESET_REQUEST_ACCEPTED_MESSAGE
from app.services.brand import BrandReader

router = APIRouter(prefix="/auth", tags=["auth"])


def me_payload(user: User, brands: BrandReader) -> Me:
    """Who is signed in, and their company with its identity (B12-11): its slug (its own sign-in page is
    /c/<slug>) and its brand."""
    company = user.company
    return Me(
        user=MeUser.model_validate(user),
        company=MeCompany(
            id=company.id,
            name=company.name,
            name_ar=company.name_ar,
            slug=company.slug,
            timezone=company.timezone,
            default_language=Language(company.default_language),
            brand=brands.of(company),
        ),
    )


@router.post("/login", response_model=Me)
def login(
    body: LoginRequest,
    request: Request,
    response: Response,
    service: AuthServiceDep,
    settings: SettingsDep,
    context: ContextDep,
    brands: BrandReaderDep,
) -> Me:
    names = cookie_names(settings.cookie_secure)
    result = service.login(
        body.email,
        body.password,
        context,
        presented_session_token=request.cookies.get(names.session),
        device_cookie=request.cookies.get(names.device),
    )
    set_session_cookies(response, settings, result.issued)
    set_device_cookie(response, settings, result.device_cookie)
    return me_payload(result.user, brands)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(
    auth: SessionAuth, service: AuthServiceDep, settings: SettingsDep, context: ContextDep
) -> Response:
    service.logout(auth, context)
    response = Response(status_code=status.HTTP_204_NO_CONTENT)
    clear_session_cookies(response, settings)
    return response


@router.get("/me", response_model=Me)
def me(auth: SessionAuth, brands: BrandReaderDep) -> Me:
    return me_payload(auth.user, brands)


@router.patch("/preferences", response_model=Me)
def update_preferences(
    body: PreferencesUpdate, auth: SessionAuth, service: PreferencesServiceDep, brands: BrandReaderDep
) -> Me:
    """The caller's language (B10-3). `SessionAuth`, not `CurrentAuth`: allowed while a password change is
    required, so the forced-change screen can switch language."""
    return me_payload(service.set_language(auth, body.language), brands)


@router.post("/change-password", status_code=status.HTTP_204_NO_CONTENT)
def change_password(
    body: ChangePasswordRequest,
    request: Request,
    auth: SessionAuth,
    db: DbSession,
    background_tasks: BackgroundTasks,
    service: AuthServiceDep,
    dispatcher: EmailDispatcherDep,
    settings: SettingsDep,
    context: ContextDep,
) -> Response:
    device = request.cookies.get(cookie_names(settings.cookie_secure).device)
    changed = service.change_password(
        auth, body.current_password, body.new_password, context, device_cookie=device
    )
    if changed.notice is not None:
        schedule_delivery(background_tasks, db, dispatcher, changed.notice)
    # The caller's session is replaced (SEC-04): the 204 carries the new session and CSRF cookies, and
    # the device cookie that now trusts this browser alone for the account (SEC-30).
    response = Response(status_code=status.HTTP_204_NO_CONTENT, background=background_tasks)
    set_session_cookies(response, settings, changed.session)
    set_device_cookie(response, settings, changed.device_cookie)
    return response


@router.post("/forgot-password", status_code=status.HTTP_202_ACCEPTED, response_model=ForgotPasswordResponse)
def forgot_password(
    body: ForgotPasswordRequest,
    background_tasks: BackgroundTasks,
    service: AuthServiceDep,
    issuer: PasswordResetIssuerDep,
    context: ContextDep,
) -> ForgotPasswordResponse:
    # The account lookup, token and e-mail happen in the background so the response (and its
    # timing) is the same whether or not the address belongs to an account.
    email = service.accept_password_reset_request(body.email, context)
    if email is not None:
        background_tasks.add_task(issuer.issue_and_deliver, email, context)
    return ForgotPasswordResponse(message=RESET_REQUEST_ACCEPTED_MESSAGE)


@router.post("/reset-password", status_code=status.HTTP_204_NO_CONTENT)
def reset_password(
    body: ResetPasswordRequest,
    request: Request,
    db: DbSession,
    background_tasks: BackgroundTasks,
    service: AuthServiceDep,
    dispatcher: EmailDispatcherDep,
    settings: SettingsDep,
    context: ContextDep,
) -> Response:
    device = request.cookies.get(cookie_names(settings.cookie_secure).device)
    reset = service.reset_password(body.token, body.new_password, context, device_cookie=device)
    if reset.notice is not None:
        schedule_delivery(background_tasks, db, dispatcher, reset.notice)
    response = Response(status_code=status.HTTP_204_NO_CONTENT, background=background_tasks)
    set_device_cookie(response, settings, reset.device_cookie)  # this browser proved control of the mailbox
    return response
