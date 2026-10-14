from fastapi import APIRouter

from app.api.deps import AdminAuth, CompanyServiceDep, ContextDep, CurrentAuth
from app.schemas.company import CompanySettings, CompanySettingsUpdate

router = APIRouter(prefix="/company", tags=["company"])


@router.get("/settings", response_model=CompanySettings)
def get_company_settings(auth: CurrentAuth, service: CompanyServiceDep) -> CompanySettings:
    return CompanySettings.model_validate(service.get_settings(auth))


@router.patch("/settings", response_model=CompanySettings)
def update_company_settings(
    body: CompanySettingsUpdate, auth: AdminAuth, service: CompanyServiceDep, context: ContextDep
) -> CompanySettings:
    return CompanySettings.model_validate(service.update_settings(auth, body, context))
