"""Session, CSRF and device cookies (contract §7.2, SEC-01; the platform owner's: B11-6).

COOKIE_SECURE=true (default): `__Host-vms_session` (HttpOnly; Secure; SameSite=Lax; Path=/) and
`__Host-vms_csrf` (readable by the SPA; Secure; SameSite=Strict; Path=/). With COOKIE_SECURE=false
(plain-http development only) the names are `vms_session` / `vms_csrf` without Secure.

The device cookie `__Host-vms_device` (HttpOnly; Secure; SameSite=Strict; Path=/; 90 days) marks a
browser that signed in to, or reset the password of, the accounts it names (`app.security.device_trust`).
Signing out keeps it.

The platform owner's session has cookies of its own with the same attributes and lifetimes of its own
(PLATFORM_SESSION_MAX_AGE_HOURS): `__Host-vms_platform_session`, `__Host-vms_platform_csrf` and
`__Host-vms_platform_device` (`app.security.platform_sessions`).
"""

from starlette.responses import Response

from app.core.config import Settings
from app.security.device_trust import DEVICE_TRUST_TTL
from app.security.platform_sessions import IssuedPlatformSession, platform_cookie_names
from app.security.sessions import CookieNames, IssuedSession, cookie_names


def _set_pair(
    response: Response, settings: Settings, names: CookieNames, token: str, csrf_token: str, max_age: int
) -> None:
    response.set_cookie(
        names.session,
        token,
        max_age=max_age,
        path="/",
        secure=settings.cookie_secure,
        httponly=True,
        samesite="lax",
    )
    response.set_cookie(
        names.csrf,
        csrf_token,
        max_age=max_age,
        path="/",
        secure=settings.cookie_secure,
        httponly=False,
        samesite="strict",
    )


def _clear_pair(response: Response, settings: Settings, names: CookieNames) -> None:
    response.delete_cookie(
        names.session, path="/", secure=settings.cookie_secure, httponly=True, samesite="lax"
    )
    response.delete_cookie(
        names.csrf, path="/", secure=settings.cookie_secure, httponly=False, samesite="strict"
    )


def _set_device(response: Response, settings: Settings, name: str, value: str) -> None:
    response.set_cookie(
        name,
        value,
        max_age=int(DEVICE_TRUST_TTL.total_seconds()),
        path="/",
        secure=settings.cookie_secure,
        httponly=True,
        samesite="strict",
    )


def set_session_cookies(response: Response, settings: Settings, issued: IssuedSession) -> None:
    names = cookie_names(settings.cookie_secure)
    _set_pair(
        response, settings, names, issued.token, issued.csrf_token, settings.session_max_age_hours * 3600
    )


def clear_session_cookies(response: Response, settings: Settings) -> None:
    _clear_pair(response, settings, cookie_names(settings.cookie_secure))


def set_device_cookie(response: Response, settings: Settings, value: str) -> None:
    _set_device(response, settings, cookie_names(settings.cookie_secure).device, value)


def set_platform_session_cookies(
    response: Response, settings: Settings, issued: IssuedPlatformSession
) -> None:
    names = platform_cookie_names(settings.cookie_secure)
    max_age = settings.platform_session_max_age_hours * 3600
    _set_pair(response, settings, names, issued.token, issued.csrf_token, max_age)


def clear_platform_session_cookies(response: Response, settings: Settings) -> None:
    _clear_pair(response, settings, platform_cookie_names(settings.cookie_secure))


def set_platform_device_cookie(response: Response, settings: Settings, value: str) -> None:
    _set_device(response, settings, platform_cookie_names(settings.cookie_secure).device, value)
