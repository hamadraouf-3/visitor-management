from fastapi import APIRouter

from app.api.routes import (
    audit_logs,
    auth,
    company,
    dashboard,
    departments,
    email_templates,
    health,
    journeys,
    locations,
    platform,
    public,
    reception,
    reports,
    tracking,
    users,
    visitors,
    visits,
)
from app.core.config import API_PREFIX
from app.schemas.common import ErrorEnvelope

_ERROR = {"model": ErrorEnvelope}

api_router = APIRouter(
    prefix=API_PREFIX,
    responses={
        401: {**_ERROR, "description": "Not authenticated"},
        403: {**_ERROR, "description": "Forbidden, CSRF failure or password change required"},
        404: {**_ERROR, "description": "Not found"},
        413: {**_ERROR, "description": "Request body too large"},
        422: {**_ERROR, "description": "Validation error (`details.fields`)"},
        429: {**_ERROR, "description": "Rate limited (`Retry-After` header)"},
        "default": {**_ERROR, "description": "Error envelope"},
    },
)
api_router.include_router(health.router)
api_router.include_router(auth.router)
api_router.include_router(users.router)
api_router.include_router(departments.router)
api_router.include_router(company.router)
api_router.include_router(visitors.router)
api_router.include_router(visits.router)
api_router.include_router(reception.router)
api_router.include_router(dashboard.router)
api_router.include_router(reports.router)
api_router.include_router(audit_logs.router)
api_router.include_router(email_templates.router)
api_router.include_router(locations.router)
api_router.include_router(tracking.router)
api_router.include_router(journeys.router)
api_router.include_router(platform.router)
api_router.include_router(public.router)
