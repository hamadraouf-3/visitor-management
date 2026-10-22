"""The Visitor Journey's tracking API (Phase 15, docs/api.md §17, docs/visitor-tracking-integration.md).

* `GET /tracking/status`: the banner (administrators, management, receptionists).
* `GET/PATCH /tracking/settings`, `GET/POST/DELETE /tracking/keys`: administrators.
* `GET /tracking/cameras`: administrators (all), receptionists (the active enrollment points);
  `POST/PATCH /tracking/cameras`: administrators.
* `POST /tracking/events`: the tracking provider, with a Bearer tracking key only (no cookie, no CSRF);
  404 while the deployment's provider is `disabled`, for every method (the route behaves as absent,
  B15-38); with a provider, another method answers 405. A batch's alert e-mails go after its commit.
* `GET /tracking/alerts`, `GET /tracking/alerts/summary` (administrators, management, receptionists);
  `POST /tracking/alerts/{id}/acknowledge` and `/resolve` (administrators, receptionists): Phase 16, B16-9.
"""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, BackgroundTasks, Query, status

from app.api.deps import (
    AdminAuth,
    ContextDep,
    DbSession,
    EmailDispatcherDep,
    ServiceEnvironmentDep,
    TrackingAlertsDep,
    TrackingBatch,
    TrackingIngestionDep,
    TrackingKeyAuth,
    TrackingSettingsServiceDep,
    TrackVisitsAuth,
    ViewJourneysAuth,
)
from app.core.errors import MethodNotAllowed, NotFound
from app.email.dispatcher import schedule_deliveries
from app.schemas.common import Paginated
from app.schemas.journeys import (
    TrackingAlert,
    TrackingAlertAction,
    TrackingAlertListQuery,
    TrackingAlertSummary,
)
from app.schemas.tracking import (
    TrackingCamera,
    TrackingCameraCreate,
    TrackingCameraListQuery,
    TrackingCameraUpdate,
    TrackingEventOutcome,
    TrackingEventResults,
    TrackingKey,
    TrackingKeyCreate,
    TrackingKeyCreated,
    TrackingSettings,
    TrackingSettingsUpdate,
    TrackingStatus,
)
from app.services.tracking_provider import IncomingEvent

router = APIRouter(prefix="/tracking", tags=["tracking"])


@router.get("/status", response_model=TrackingStatus)
def get_tracking_status(auth: ViewJourneysAuth, service: TrackingSettingsServiceDep) -> TrackingStatus:
    return service.status(auth)


@router.get("/settings", response_model=TrackingSettings)
def get_tracking_settings(auth: AdminAuth, service: TrackingSettingsServiceDep) -> TrackingSettings:
    return service.get(auth)


@router.patch("/settings", response_model=TrackingSettings)
def update_tracking_settings(
    body: TrackingSettingsUpdate, auth: AdminAuth, service: TrackingSettingsServiceDep, context: ContextDep
) -> TrackingSettings:
    """`enabled: true` needs the platform owner's permission (409 TRACKING_NOT_AVAILABLE otherwise);
    `enabled: false` ends the company's open tracking associations."""
    return service.update(auth, body, context)


@router.get("/keys", response_model=list[TrackingKey])
def list_tracking_keys(auth: AdminAuth, service: TrackingSettingsServiceDep) -> list[TrackingKey]:
    return service.list_keys(auth)


@router.post("/keys", response_model=TrackingKeyCreated, status_code=status.HTTP_201_CREATED)
def create_tracking_key(
    body: TrackingKeyCreate, auth: AdminAuth, service: TrackingSettingsServiceDep, context: ContextDep
) -> TrackingKeyCreated:
    """The only answer that carries the key (`secret`); it is stored as a SHA-256 digest. At most two
    unrevoked keys per company (409 TRACKING_KEY_LIMIT)."""
    return service.create_key(auth, body, context)


@router.delete("/keys/{key_id}", response_model=TrackingKey)
def revoke_tracking_key(
    key_id: UUID, auth: AdminAuth, service: TrackingSettingsServiceDep, context: ContextDep
) -> TrackingKey:
    return service.revoke_key(auth, key_id, context)


@router.get("/cameras", response_model=list[TrackingCamera])
def list_tracking_cameras(
    auth: TrackVisitsAuth,
    service: TrackingSettingsServiceDep,
    query: Annotated[TrackingCameraListQuery, Query()],
) -> list[TrackingCamera]:
    """Administrators: every active camera (and the archived ones with `include_archived=true`).
    Receptionists: the active enrollment points only."""
    return service.list_cameras(auth, include_archived=query.include_archived)


@router.post("/cameras", response_model=TrackingCamera, status_code=status.HTTP_201_CREATED)
def create_tracking_camera(
    body: TrackingCameraCreate, auth: AdminAuth, service: TrackingSettingsServiceDep, context: ContextDep
) -> TrackingCamera:
    return service.create_camera(auth, body, context)


@router.patch("/cameras/{camera_id}", response_model=TrackingCamera)
def update_tracking_camera(
    camera_id: UUID,
    body: TrackingCameraUpdate,
    auth: AdminAuth,
    service: TrackingSettingsServiceDep,
    context: ContextDep,
) -> TrackingCamera:
    return service.update_camera(auth, camera_id, body, context)


@router.get("/alerts", response_model=Paginated[TrackingAlert])
def list_tracking_alerts(
    auth: ViewJourneysAuth,
    service: TrackingAlertsDep,
    query: Annotated[TrackingAlertListQuery, Query()],
) -> Paginated[TrackingAlert]:
    """`scope=active` (default): the OPEN and ACKNOWLEDGED alerts, any day; `scope=day`: those opened during
    the company-local `day` (default today), any status. Newest `opened_at` first."""
    page = service.list_alerts(auth, query)
    return Paginated[TrackingAlert](
        items=page.items, page=page.page, page_size=page.page_size, total=page.total
    )


@router.get("/alerts/summary", response_model=TrackingAlertSummary)
def tracking_alert_summary(auth: ViewJourneysAuth, service: TrackingAlertsDep) -> TrackingAlertSummary:
    """Counts and the latest open alerts, for the interface's shell (polled with `X-Background-Refresh: 1`,
    which never extends the session). All zeros while tracking is not allowed or there is no provider."""
    return service.summary(auth)


@router.post("/alerts/{alert_id}/acknowledge", response_model=TrackingAlert)
def acknowledge_tracking_alert(
    alert_id: UUID,
    auth: TrackVisitsAuth,
    service: TrackingAlertsDep,
    context: ContextDep,
    body: TrackingAlertAction | None = None,
) -> TrackingAlert:
    """OPEN -> ACKNOWLEDGED (an acknowledged alert is answered as it is); a resolved one: 409
    ALERT_RESOLVED. The body is optional."""
    return service.acknowledge(auth, alert_id, body or TrackingAlertAction(), context)


@router.post("/alerts/{alert_id}/resolve", response_model=TrackingAlert)
def resolve_tracking_alert(
    alert_id: UUID,
    auth: TrackVisitsAuth,
    service: TrackingAlertsDep,
    context: ContextDep,
    body: TrackingAlertAction | None = None,
) -> TrackingAlert:
    """-> RESOLVED (MANUAL); a resolved alert is answered as it is. The body is optional."""
    return service.resolve(auth, alert_id, body or TrackingAlertAction(), context)


# Every method but POST on the ingestion path (B15-38): absent while the provider is disabled, like the
# POST, else 405. Not in the OpenAPI document.
OTHER_EVENT_METHODS = ["GET", "HEAD", "PUT", "PATCH", "DELETE", "OPTIONS"]


@router.api_route("/events", methods=OTHER_EVENT_METHODS, include_in_schema=False)
def tracking_events_other_methods(env: ServiceEnvironmentDep) -> None:
    if not env.tracking.enabled:
        raise NotFound()
    raise MethodNotAllowed()


@router.post("/events", response_model=TrackingEventResults)
def ingest_tracking_events(
    key: TrackingKeyAuth,
    batch: TrackingBatch,
    service: TrackingIngestionDep,
    db: DbSession,
    dispatcher: EmailDispatcherDep,
    background_tasks: BackgroundTasks,
    context: ContextDep,
) -> TrackingEventResults:
    """The tracking provider's events (a JSON `TrackingEventBatch` of at most 100). Answers 200 with one
    outcome per event, in order: `accepted`, `duplicate` or `rejected` with its reason."""
    outcomes = service.ingest(
        key.company_id,
        [
            IncomingEvent(
                provider_event_id=event.provider_event_id,
                type=event.type,
                observed_at=event.observed_at,
                association_ref=event.association_ref,
                camera_id=event.camera_id,
                match=event.match,
                confidence=event.confidence,
                model_version=event.model_version,
            )
            for event in batch.events
        ],
        key_id=key.key_id,
        context=context,
    )
    # The alert e-mails of the batch, after its commit (B16-14).
    schedule_deliveries(background_tasks, db, dispatcher, service.alert_jobs)
    return TrackingEventResults(
        results=[
            TrackingEventOutcome(
                provider_event_id=outcome.provider_event_id, result=outcome.result, reason=outcome.reason
            )
            for outcome in outcomes
        ]
    )
