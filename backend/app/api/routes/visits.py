from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, BackgroundTasks, Query, status

from app.api.deps import (
    AttendanceServiceDep,
    ContextDep,
    CreateVisitAuth,
    DbSession,
    EmailDispatcherDep,
    ManageVisitsAuth,
    ReadVisitsAuth,
    ReceptionAuth,
    VisitsServiceDep,
)
from app.email.dispatcher import schedule_deliveries
from app.schemas.common import Paginated
from app.schemas.visits import (
    CheckInRequest,
    CheckOutRequest,
    Visit,
    VisitCancel,
    VisitCreate,
    VisitCreateResult,
    VisitListQuery,
    VisitPassResult,
    VisitUpdate,
)

router = APIRouter(prefix="/visits", tags=["visits"])


@router.get("", response_model=Paginated[Visit])
def list_visits(
    auth: ReadVisitsAuth, service: VisitsServiceDep, query: Annotated[VisitListQuery, Query()]
) -> Paginated[Visit]:
    return service.list_visits(auth, query)


@router.post("", response_model=VisitCreateResult, status_code=status.HTTP_201_CREATED)
def create_visit(
    body: VisitCreate,
    auth: CreateVisitAuth,
    service: VisitsServiceDep,
    db: DbSession,
    dispatcher: EmailDispatcherDep,
    background_tasks: BackgroundTasks,
    context: ContextDep,
) -> VisitCreateResult:
    result = service.create_visit(auth, body, context)
    schedule_deliveries(background_tasks, db, dispatcher, result.delivery_jobs)
    return result.payload


@router.get("/{visit_id}", response_model=Visit)
def get_visit(visit_id: UUID, auth: ReadVisitsAuth, service: VisitsServiceDep) -> Visit:
    return service.get_visit(auth, visit_id)


@router.patch("/{visit_id}", response_model=Visit)
def update_visit(
    visit_id: UUID,
    body: VisitUpdate,
    auth: ManageVisitsAuth,
    service: VisitsServiceDep,
    db: DbSession,
    dispatcher: EmailDispatcherDep,
    background_tasks: BackgroundTasks,
    context: ContextDep,
) -> Visit:
    result = service.update_visit(auth, visit_id, body, context)
    schedule_deliveries(background_tasks, db, dispatcher, result.delivery_jobs)
    return result.payload


@router.post("/{visit_id}/cancel", response_model=Visit)
def cancel_visit(
    visit_id: UUID,
    auth: ManageVisitsAuth,
    service: VisitsServiceDep,
    db: DbSession,
    dispatcher: EmailDispatcherDep,
    background_tasks: BackgroundTasks,
    context: ContextDep,
    body: VisitCancel | None = None,
) -> Visit:
    """The body is optional: without one the visit is cancelled without a reason and the visitor is
    notified."""
    result = service.cancel_visit(auth, visit_id, body or VisitCancel(), context)
    schedule_deliveries(background_tasks, db, dispatcher, result.delivery_jobs)
    return result.payload


@router.post("/{visit_id}/invitation", response_model=VisitCreateResult)
def resend_invitation(
    visit_id: UUID,
    auth: ManageVisitsAuth,
    service: VisitsServiceDep,
    db: DbSession,
    dispatcher: EmailDispatcherDep,
    background_tasks: BackgroundTasks,
    context: ContextDep,
) -> VisitCreateResult:
    """Rotates the pass: the previous QR code stops working."""
    result = service.resend_invitation(auth, visit_id, context)
    schedule_deliveries(background_tasks, db, dispatcher, result.delivery_jobs)
    return result.payload


@router.post("/{visit_id}/pass", response_model=VisitPassResult)
def reissue_pass(
    visit_id: UUID, auth: ManageVisitsAuth, service: VisitsServiceDep, context: ContextDep
) -> VisitPassResult:
    """Rotates the pass and returns its link once, without sending an e-mail: the previous QR code
    stops working."""
    return service.reissue_pass(auth, visit_id, context)


@router.post("/{visit_id}/check-in", response_model=Visit)
def check_in(
    visit_id: UUID,
    body: CheckInRequest,
    auth: ReceptionAuth,
    service: AttendanceServiceDep,
    db: DbSession,
    dispatcher: EmailDispatcherDep,
    background_tasks: BackgroundTasks,
    context: ContextDep,
) -> Visit:
    """QR (a pass of this visit, valid now), MANUAL (after an ID check, within the visit's window) or
    OVERRIDE (with a reason, on the visit's day). Refusals carry the visit and the check-in options in
    `details`, as scan errors do."""
    result = service.check_in(auth, visit_id, body, context)
    schedule_deliveries(background_tasks, db, dispatcher, result.delivery_jobs)
    return result.payload


@router.post("/{visit_id}/check-out", response_model=Visit)
def check_out(
    visit_id: UUID,
    body: CheckOutRequest,
    auth: ReceptionAuth,
    service: AttendanceServiceDep,
    context: ContextDep,
) -> Visit:
    """QR (a pass of this visit), MANUAL, or CORRECTED (an earlier time between the check-in and now,
    with a note)."""
    return service.check_out(auth, visit_id, body, context)
