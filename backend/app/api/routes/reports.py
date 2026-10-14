from typing import Annotated

from fastapi import APIRouter, Query

from app.api.deps import ReportsAuth, ReportsServiceDep
from app.schemas.reports import ReportSummary, ReportSummaryQuery

router = APIRouter(prefix="/reports", tags=["reports"])


@router.get("/summary", response_model=ReportSummary)
def report_summary(
    auth: ReportsAuth, service: ReportsServiceDep, query: Annotated[ReportSummaryQuery, Query()]
) -> ReportSummary:
    """Company-local dates, inclusive; by default the last 30 days, at most 366 days."""
    return service.summary(auth, query)
