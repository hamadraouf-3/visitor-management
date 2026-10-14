from typing import Annotated

from fastapi import APIRouter, Query

from app.api.deps import AuditAuth, AuditTrailServiceDep
from app.schemas.audit import AuditLog, AuditLogQuery
from app.schemas.common import Paginated

router = APIRouter(prefix="/audit-logs", tags=["audit"])


@router.get("", response_model=Paginated[AuditLog])
def list_audit_logs(
    auth: AuditAuth, service: AuditTrailServiceDep, query: Annotated[AuditLogQuery, Query()]
) -> Paginated[AuditLog]:
    """The company's audit trail, newest first; dates are company-local."""
    return service.search(auth, query)
