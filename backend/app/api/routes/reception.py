from fastapi import APIRouter, BackgroundTasks, status

from app.api.deps import (
    AttendanceServiceDep,
    ContextDep,
    DbSession,
    EmailDispatcherDep,
    ReceptionAuth,
    ReceptionServiceDep,
    ScanServiceDep,
    ViewInsideAuth,
)
from app.email.dispatcher import schedule_deliveries
from app.schemas.reception import (
    InsideList,
    ReceptionToday,
    ScanRequest,
    ScanResult,
    StaleCheckOutRequest,
    StaleCheckOutResult,
)
from app.schemas.visits import Visit, WalkInCreate

router = APIRouter(prefix="/reception", tags=["reception"])


@router.post("/scan", response_model=ScanResult)
def scan_pass(
    body: ScanRequest, auth: ReceptionAuth, service: ScanServiceDep, context: ContextDep
) -> ScanResult:
    """Contract §6: READY / ALREADY_CHECKED_IN, or the row's error with `details.visit` and
    `details.check_in_options`. An invalid pass is 404 PASS_INVALID."""
    return service.scan(auth, body.token, context)


@router.get("/today", response_model=ReceptionToday)
def reception_today(auth: ReceptionAuth, service: ReceptionServiceDep) -> ReceptionToday:
    """Today's expected, inside, checked-out and no-show visits (each list at most 200; counts exact)."""
    return service.today(auth)


@router.get("/inside", response_model=InsideList)
def visitors_inside(auth: ViewInsideAuth, service: ReceptionServiceDep) -> InsideList:
    """Everyone checked in, whatever the day (the evacuation list), with each visitor's current phone;
    never capped."""
    return service.inside(auth)


@router.post("/check-out-stale", response_model=StaleCheckOutResult)
def check_out_stale(
    body: StaleCheckOutRequest, auth: ReceptionAuth, service: AttendanceServiceDep, context: ContextDep
) -> StaleCheckOutResult:
    """Check out every visit still checked in from an earlier day whose scheduled end has passed (method
    BULK, the reason as note)."""
    return service.check_out_stale(auth, body, context)


@router.post("/walk-ins", response_model=Visit, status_code=status.HTTP_201_CREATED)
def register_walk_in(
    body: WalkInCreate,
    auth: ReceptionAuth,
    service: AttendanceServiceDep,
    db: DbSession,
    dispatcher: EmailDispatcherDep,
    background_tasks: BackgroundTasks,
    context: ContextDep,
) -> Visit:
    """Register and check in a visitor without an invitation (409 WALK_INS_DISABLED when the company
    does not allow walk-ins)."""
    result = service.register_walk_in(auth, body, context)
    schedule_deliveries(background_tasks, db, dispatcher, result.delivery_jobs)
    return result.payload
