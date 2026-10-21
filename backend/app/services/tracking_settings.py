"""A company's tracking settings, status, keys and cameras (Phase 15, /api/v1/tracking).

* **Settings** (`allowed` is the platform owner's, B15-2; the rest the company administrator's):
  `enabled` only while allowed; switching it off ends every open association of the company (REVOKED).
  `min_confidence` has no default: null confirms nothing until an evaluation on site footage sets it
  (B15-12). A company without a settings row has the defaults; the first change writes the row.
* **Status**: what the Visitor Journey page's banner needs, for every role that sees journeys.
* **Keys**: at most two unrevoked per company (a partial unique index over a slot, B15-10); the key is
  answered once, at its creation, and stored as its SHA-256 digest.
* **Cameras**: the provider's camera IDs, each in an active zone; receptionists read the active
  enrollment points only.

Every change starts with the company row locked (`lock_company_for_change`: `FOR UPDATE` for settings,
`FOR KEY SHARE` otherwise) and the caller re-checked (SEC-07); every change is audited with IDs, enums and
changed-field names only.
"""

from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime
from typing import cast
from uuid import UUID

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core import time as app_time
from app.core.errors import Conflict, Forbidden, TrackingKeyLimit, TrackingNotAvailable
from app.core.field_errors import FieldCode, FieldProblem
from app.core.request_context import RequestContext
from app.db.errors import unique_violation_constraint
from app.models import CompanyTrackingSettings, TrackingCamera, TrackingKey
from app.models.tracking import RETENTION_DAYS_DEFAULT, STALE_AFTER_MINUTES_DEFAULT
from app.repositories.locking import RowLock
from app.repositories.tracking import (
    CameraRepository,
    LocationRepository,
    PlacedZone,
    TrackingHealthRepository,
    TrackingKeyRepository,
    TrackingSettingsRepository,
)
from app.repositories.users import UserRepository
from app.schemas.common import UserRef
from app.schemas.locations import FloorRef, JourneyLocation, LocationRef
from app.schemas.tracking import (
    TrackingCamera as TrackingCameraOut,
)
from app.schemas.tracking import (
    TrackingCameraCreate,
    TrackingCameraUpdate,
    TrackingHealth,
    TrackingKeyCreate,
    TrackingKeyCreated,
    TrackingProviderErrorCount,
    TrackingProviderName,
    TrackingRejectionCount,
    TrackingSettings,
    TrackingSettingsUpdate,
    TrackingStatus,
)
from app.schemas.tracking import (
    TrackingKey as TrackingKeyOut,
)
from app.security.permissions import Capability, has_capability
from app.security.sessions import AuthContext
from app.services import audit
from app.services.audit import AuditAction, AuditEntity
from app.services.authorization import lock_company_for_change
from app.services.scoping import REFERENCE_NOT_FOUND, FieldErrors, require_found
from app.services.tracking_lifecycle import EndTrigger, TrackingLifecycle
from app.services.tracking_provider import TrackingProvider
from app.services.tracking_rules import (
    MAX_LIVE_KEYS,
    PROVIDER_CONTACT_TIMEOUT,
    ProviderOperation,
    RejectReason,
    new_key,
    provider_operation_of,
)

PROVIDER_CAMERA_CONSTRAINT = "uq_tracking_cameras_company_id_provider_camera_id"
PROVIDER_CAMERA_TAKEN = "A camera with this provider camera ID already exists."
LIVE_SLOT_CONSTRAINT = "uq_tracking_keys_live_slot"
LOCATION_ARCHIVED = FieldProblem(FieldCode.LOCATION_ARCHIVED, "This location is archived.")


@dataclass(frozen=True, slots=True)
class EffectiveSettings:
    allowed: bool = False
    enabled: bool = False
    min_confidence: float | None = None
    stale_after_minutes: int = STALE_AFTER_MINUTES_DEFAULT
    retention_days: int = RETENTION_DAYS_DEFAULT


def effective_settings(row: CompanyTrackingSettings | None) -> EffectiveSettings:
    """The company's settings, or the defaults while it has no row."""
    if row is None:
        return EffectiveSettings()
    return EffectiveSettings(
        allowed=row.allowed,
        enabled=row.enabled,
        min_confidence=row.min_confidence,
        stale_after_minutes=row.stale_after_minutes,
        retention_days=row.retention_days,
    )


def is_healthy(
    provider: TrackingProvider,
    settings: EffectiveSettings,
    last_contact_at: datetime | None,
    *,
    now: datetime,
) -> bool:
    return (
        provider.enabled
        and settings.allowed
        and settings.enabled
        and provider.health().reachable
        and last_contact_at is not None
        and now - last_contact_at <= PROVIDER_CONTACT_TIMEOUT
    )


def journey_location(place: PlacedZone) -> JourneyLocation:
    return JourneyLocation(
        building=LocationRef(id=place.building.id, name=place.building.name, name_ar=place.building.name_ar),
        floor=FloorRef(
            id=place.floor.id, name=place.floor.name, name_ar=place.floor.name_ar, level=place.floor.level
        ),
        zone=LocationRef(id=place.zone.id, name=place.zone.name, name_ar=place.zone.name_ar),
    )


def provider_label(provider: TrackingProvider) -> TrackingProviderName:
    """The provider's name as the API spells it (`TRACKING_PROVIDER`: only these two exist)."""
    return cast(TrackingProviderName, provider.name)


class TrackingSettingsService:
    def __init__(self, db: Session, provider: TrackingProvider) -> None:
        self.db = db
        self.provider = provider
        self.settings = TrackingSettingsRepository(db)
        self.health = TrackingHealthRepository(db)
        self.keys = TrackingKeyRepository(db)
        self.cameras = CameraRepository(db)
        self.locations = LocationRepository(db)

    # ---- status and settings --------------------------------------------------------------------

    def status(self, auth: AuthContext) -> TrackingStatus:
        settings = effective_settings(self.settings.get(auth.company_id))
        health = self.health.get(auth.company_id)
        last_contact = health.last_contact_at if health is not None else None
        return TrackingStatus(
            provider=provider_label(self.provider),
            simulated=self.provider.name == "simulator",
            available=self.provider.enabled,
            allowed=settings.allowed,
            enabled=settings.enabled,
            last_contact_at=last_contact,
            healthy=is_healthy(self.provider, settings, last_contact, now=app_time.now()),
        )

    def get(self, auth: AuthContext) -> TrackingSettings:
        return self._view(auth.company_id, effective_settings(self.settings.get(auth.company_id)))

    def update(
        self, auth: AuthContext, data: TrackingSettingsUpdate, context: RequestContext
    ) -> TrackingSettings:
        lock_company_for_change(self.db, auth, lock=RowLock.UPDATE)
        now = app_time.now()
        supplied = data.model_fields_set
        current = effective_settings(self.settings.get(auth.company_id))
        if data.enabled and not current.allowed:
            raise TrackingNotAvailable(
                "NOT_ALLOWED", "The platform owner has not allowed tracking for this company."
            )
        changes: dict[str, object] = {}
        for name in ("enabled", "min_confidence", "stale_after_minutes", "retention_days"):
            if name in supplied and getattr(data, name) != getattr(current, name):
                changes[name] = getattr(data, name)
        if not changes:
            return self._view(auth.company_id, current)
        row = self.settings.lock(auth.company_id, now=now)
        for name, value in changes.items():
            setattr(row, name, value)
        row.updated_at = now
        self.db.flush()
        lifecycle = TrackingLifecycle(self.db, self.provider)
        if "enabled" in changes:
            revoked = 0
            if not row.enabled:
                revoked = lifecycle.end_all_of_company(
                    auth.company_id,
                    trigger=EndTrigger.TRACKING_DISABLED,
                    now=now,
                    context=context,
                    actor_id=auth.user_id,
                )
            self._audit(
                auth,
                AuditAction.TRACKING_ENABLED if row.enabled else AuditAction.TRACKING_DISABLED,
                context,
                {} if row.enabled else {"revoked": revoked},
            )
        others = sorted(name for name in changes if name != "enabled")
        if others:
            self._audit(auth, AuditAction.TRACKING_SETTINGS_UPDATED, context, {"changed_fields": others})
        view = self._view(auth.company_id, effective_settings(row))
        self.db.commit()
        lifecycle.after_commit(now=now)
        return view

    def _view(self, company_id: UUID, settings: EffectiveSettings) -> TrackingSettings:
        health = self.health.get(company_id)
        counts = self.health.counts_since(company_id, now=app_time.now())
        rejected = [
            TrackingRejectionCount(reason=RejectReason(reason), count=count)
            for reason, count in sorted(counts.items())
            if reason in RejectReason.__members__ and count > 0
        ]
        errors: list[TrackingProviderErrorCount] = []
        for reason, count in sorted(counts.items()):
            operation = provider_operation_of(reason)
            if operation is not None and count > 0:
                errors.append(TrackingProviderErrorCount(operation=ProviderOperation(operation), count=count))
        return TrackingSettings(
            provider=provider_label(self.provider),
            allowed=settings.allowed,
            enabled=settings.enabled,
            min_confidence=settings.min_confidence,
            stale_after_minutes=settings.stale_after_minutes,
            retention_days=settings.retention_days,
            health=TrackingHealth(
                last_contact_at=health.last_contact_at if health is not None else None,
                last_accepted_event_at=health.last_accepted_event_at if health is not None else None,
                rejected_last_24h=rejected,
                provider_errors_last_24h=errors,
            ),
        )

    # ---- keys -------------------------------------------------------------------------------------

    def list_keys(self, auth: AuthContext) -> list[TrackingKeyOut]:
        return self._key_views(auth.company_id, self.keys.in_company(auth.company_id))

    def create_key(
        self, auth: AuthContext, data: TrackingKeyCreate, context: RequestContext
    ) -> TrackingKeyCreated:
        lock_company_for_change(self.db, auth, lock=RowLock.UPDATE)
        free = [
            slot for slot in range(1, MAX_LIVE_KEYS + 1) if slot not in self.keys.live_slots(auth.company_id)
        ]
        if not free:
            raise TrackingKeyLimit()
        made = new_key()
        now = app_time.now()
        key = TrackingKey(
            company_id=auth.company_id,
            label=data.label,
            prefix=made.prefix,
            key_hash=made.digest,
            slot=free[0],
            created_by_id=auth.user_id,
            created_at=now,
        )
        try:
            with self.db.begin_nested():
                self.db.add(key)
                self.db.flush()
        except IntegrityError as exc:
            if (
                unique_violation_constraint(exc) == LIVE_SLOT_CONSTRAINT
            ):  # pragma: no cover - the company lock serialises
                raise TrackingKeyLimit() from None
            raise
        self._audit(
            auth,
            AuditAction.TRACKING_KEY_CREATED,
            context,
            {},
            entity=AuditEntity.TRACKING_KEY,
            entity_id=key.id,
        )
        view = self._key_views(auth.company_id, [key])[0]
        self.db.commit()
        return TrackingKeyCreated(**view.model_dump(), secret=made.secret)

    def revoke_key(self, auth: AuthContext, key_id: UUID, context: RequestContext) -> TrackingKeyOut:
        lock_company_for_change(self.db, auth, lock=RowLock.UPDATE)
        key = require_found(self.keys.get(auth.company_id, key_id, lock=RowLock.UPDATE))
        if key.revoked_at is None:
            key.revoked_at = app_time.now()
            key.revoked_by_id = auth.user_id
            self.db.flush()
            self._audit(
                auth,
                AuditAction.TRACKING_KEY_REVOKED,
                context,
                {},
                entity=AuditEntity.TRACKING_KEY,
                entity_id=key.id,
            )
            self.db.commit()
        return self._key_views(auth.company_id, [key])[0]

    def _key_views(self, company_id: UUID, keys: list[TrackingKey]) -> list[TrackingKeyOut]:
        users = UserRepository(self.db)
        creators = {key.created_by_id for key in keys}
        names = {user_id: users.get_in_company(company_id, user_id) for user_id in creators}
        return [
            TrackingKeyOut(
                id=key.id,
                label=key.label,
                prefix=key.prefix,
                created_at=key.created_at,
                created_by=(
                    UserRef(id=key.created_by_id, full_name=creator.full_name)
                    if (creator := names.get(key.created_by_id)) is not None
                    else None
                ),
                last_used_at=key.last_used_at,
                revoked_at=key.revoked_at,
            )
            for key in keys
        ]

    # ---- cameras ----------------------------------------------------------------------------------

    def list_cameras(self, auth: AuthContext, *, include_archived: bool) -> list[TrackingCameraOut]:
        administrator = has_capability(auth.roles, Capability.ADMINISTER)
        if include_archived and not administrator:
            raise Forbidden()
        cameras = self.cameras.in_company(
            auth.company_id, include_archived=include_archived, enrollment_points_only=not administrator
        )
        views = self._camera_views(auth.company_id, cameras)
        if administrator:
            return views
        # Receptionists: the enrollment points that can enroll now (their zone, floor and building active).
        places = self.locations.placed(auth.company_id, {camera.zone_id for camera in cameras})
        return [view for view, camera in zip(views, cameras, strict=True) if places[camera.zone_id].active]

    def create_camera(
        self, auth: AuthContext, data: TrackingCameraCreate, context: RequestContext
    ) -> TrackingCameraOut:
        lock_company_for_change(self.db, auth, lock=RowLock.KEY_SHARE)
        self._require_active_zone(auth.company_id, data.zone_id)
        self._require_free_provider_id(auth.company_id, data.provider_camera_id)
        now = app_time.now()
        camera = TrackingCamera(
            company_id=auth.company_id,
            provider_camera_id=data.provider_camera_id,
            name=data.name,
            zone_id=data.zone_id,
            is_enrollment_point=data.is_enrollment_point,
            is_active=True,
            created_at=now,
            updated_at=now,
        )
        self._save(camera)
        self._audit(
            auth,
            AuditAction.TRACKING_CAMERA_CREATED,
            context,
            {},
            entity=AuditEntity.TRACKING_CAMERA,
            entity_id=camera.id,
        )
        view = self._camera_views(auth.company_id, [camera])[0]
        self.db.commit()
        return view

    def update_camera(
        self, auth: AuthContext, camera_id: UUID, data: TrackingCameraUpdate, context: RequestContext
    ) -> TrackingCameraOut:
        lock_company_for_change(self.db, auth, lock=RowLock.KEY_SHARE)
        camera = require_found(self.cameras.get(auth.company_id, camera_id, lock=RowLock.UPDATE))
        supplied = data.model_fields_set
        changed: list[str] = []
        zone_id = data.zone_id if "zone_id" in supplied and data.zone_id is not None else camera.zone_id
        restoring = data.is_active is True and not camera.is_active
        if zone_id != camera.zone_id or restoring:
            self._require_active_zone(
                auth.company_id, zone_id, field="zone_id" if zone_id != camera.zone_id else "is_active"
            )
        if data.provider_camera_id is not None and data.provider_camera_id != camera.provider_camera_id:
            self._require_free_provider_id(auth.company_id, data.provider_camera_id)
        for name in ("provider_camera_id", "name", "zone_id", "is_enrollment_point", "is_active"):
            value = getattr(data, name)
            if name in supplied and value is not None and value != getattr(camera, name):
                setattr(camera, name, value)
                changed.append(name)
        if not changed:
            return self._camera_views(auth.company_id, [camera])[0]
        camera.updated_at = app_time.now()
        self._save(camera)
        self._audit(
            auth,
            AuditAction.TRACKING_CAMERA_UPDATED,
            context,
            {"changed_fields": changed},
            entity=AuditEntity.TRACKING_CAMERA,
            entity_id=camera.id,
        )
        view = self._camera_views(auth.company_id, [camera])[0]
        self.db.commit()
        return view

    def _require_active_zone(self, company_id: UUID, zone_id: UUID, *, field: str = "zone_id") -> None:
        place = self.locations.placed(company_id, {zone_id}).get(zone_id)
        errors = FieldErrors()
        if place is None:
            errors.add("zone_id", REFERENCE_NOT_FOUND)
        elif not place.active:
            errors.add(field, LOCATION_ARCHIVED)
        errors.raise_if_any()

    def _require_free_provider_id(self, company_id: UUID, provider_camera_id: str) -> None:
        if self.cameras.by_provider_id(company_id, provider_camera_id) is not None:
            raise Conflict("provider_camera_id", PROVIDER_CAMERA_TAKEN)

    def _save(self, camera: TrackingCamera) -> None:
        try:
            with self.db.begin_nested():
                self.db.add(camera)
                self.db.flush()
        except IntegrityError as exc:
            if unique_violation_constraint(exc) == PROVIDER_CAMERA_CONSTRAINT:
                raise Conflict("provider_camera_id", PROVIDER_CAMERA_TAKEN) from None
            raise

    def _camera_views(self, company_id: UUID, cameras: list[TrackingCamera]) -> list[TrackingCameraOut]:
        places = self.locations.placed(company_id, {camera.zone_id for camera in cameras})
        return [
            TrackingCameraOut(
                id=camera.id,
                provider_camera_id=camera.provider_camera_id,
                name=camera.name,
                zone_id=camera.zone_id,
                location=journey_location(places[camera.zone_id]),
                is_enrollment_point=camera.is_enrollment_point,
                is_active=camera.is_active,
                created_at=camera.created_at,
                updated_at=camera.updated_at,
            )
            for camera in cameras
        ]

    def _audit(
        self,
        auth: AuthContext,
        action: AuditAction,
        context: RequestContext,
        metadata: Mapping[str, object],
        *,
        entity: AuditEntity = AuditEntity.COMPANY,
        entity_id: UUID | None = None,
    ) -> None:
        audit.record(
            self.db,
            action=action,
            context=context,
            company_id=auth.company_id,
            actor_user_id=auth.user_id,
            entity_type=entity,
            entity_id=entity_id or auth.company_id,
            metadata=metadata,
        )
