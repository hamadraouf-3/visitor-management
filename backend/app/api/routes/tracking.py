"""The Visitor Journey's tracking API (Phase 15, docs/api.md §17, docs/visitor-tracking-integration.md).

* `GET /tracking/status`: the banner (administrators, management, receptionists).
* `GET/PATCH /tracking/settings`, `GET/POST/DELETE /tracking/keys`: administrators.
* `GET /tracking/cameras`: administrators (all), receptionists (the active enrollment points);
  `POST/PATCH /tracking/cameras`: administrators.
* `POST /tracking/events`: the tracking provider, with a Bearer tracking key only (no cookie, no CSRF);
  404 while the deployment's provider is `disabled`, for every method (the route behaves as absent,
  B15-38); with a provider, another method answers 405.
"""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Query, status

from app.api.deps import (
    AdminAuth,
    ContextDep,
    ServiceEnvironmentDep,
    TrackingBatch,
    TrackingIngestionDep,
    TrackingKeyAuth,
    TrackingSettingsServiceDep,
    TrackVisitsAuth,
    ViewJourneysAuth,
)
from app.core.errors import MethodNotAllowed, NotFound
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
    key: TrackingKeyAuth, batch: TrackingBatch, service: TrackingIngestionDep, context: ContextDep
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
    return TrackingEventResults(
        results=[
            TrackingEventOutcome(
                provider_event_id=outcome.provider_event_id, result=outcome.result, reason=outcome.reason
            )
            for outcome in outcomes
        ]
    )
