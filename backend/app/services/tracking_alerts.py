"""Area alerts (Phase 16, docs/visitor-journey-design.md §9, B16-4 to B16-17).

**The trigger** (B16-5). After an ingested batch stores at least one confirmed OBSERVED event with a
location for a visit whose association is ACTIVE, the visit is evaluated **in the batch's transaction**,
from the journey's own current location (`journey_current.current_journeys`, the function the API shows):
only while the journey's state is ACTIVE (fresh, confirmed, no conflict within 60 s), its `last_location`
is not null, and the latest confirmed observation is one this batch stored. So an old event arriving late
never opens or resolves anything, a late sighting of an ended association never alerts (its journey is
ENDED, or the latest association is another one), and with a null threshold nothing is confirmed and
nothing alerts. A company with `area_alerts_enabled` false is not evaluated (its active alerts stay).

**The rule** (`tracking_rules.violation`, B16-4), then for the visit's active alert (OPEN or ACKNOWLEDGED,
one at most, locked after the association, B16-7):

* a violation and no active alert: an OPEN alert (first and last location the current one, first and last
  seen its `observed_at`, one observation), audited TRACKING_ALERT_OPENED without an actor, e-mailed;
* a violation and an active alert: its latest location, `last_seen_at` and observations move on; a
  RESTRICTED_AREA violation of an UNAUTHORIZED_AREA alert **escalates** it (type RESTRICTED_AREA, OPEN again,
  its acknowledgement cleared, `escalated_at` now: B16-26), audited TRACKING_ALERT_ESCALATED and e-mailed
  again; no row per observation;
* no violation and an active alert: RESOLVED, `RETURNED`, without an actor.

**Other ends** (B16-8): a check-out resolves the active alert (`CHECKED_OUT`, the checking-out user) in the
check-out's transaction; a change of the visit's allowed areas re-evaluates its current location
(`AREAS_CHANGED`, the editor; or, for a receptionist's or an administrator's change only, opens or escalates
the alert that the new areas now call for: a host's change never raises one, the next confirmed observation
does, B16-25); a receptionist or an administrator acknowledges (OPEN -> ACKNOWLEDGED; again: unchanged; a
resolved alert: 409 ALERT_RESOLVED) or resolves (`MANUAL`; again: unchanged), each with an optional one-line
note. A revoke, an expiry or tracking switched off leave the alert as it is.

**E-mails** (B16-14, B16-15, B16-25): on an opening and on an escalation only, queued in the transaction
and delivered after its commit (contract §3.2-1), within the company's daily budget of alert e-mails and
the visit's hourly budget of e-mailed openings and escalations: to each of the company's `alert_emails`
(its language, a link to the visitor's journey) and, with `alert_notify_host`, to the visit's active host
(the host's language, a link to the visit's page: a host who is only an employee cannot open journeys,
B15-13). An address that is both gets the alert addresses' e-mail once. Never a pass link, a token, a
tracking reference or a key.
"""

import logging
from collections.abc import Collection, Iterator, Mapping, Sequence
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core import time as app_time
from app.core.errors import AlertResolved
from app.core.rate_limit import PolicyName
from app.core.request_context import RequestContext
from app.core.time import company_day_bounds, local_date
from app.email.rendering import COMMA
from app.email.service import AlertFacts, AlertLink, DeliveryJob, EmailService, mailbox_key
from app.models import Company, Language, TrackingAlert, Visit
from app.models.enums import (
    TrackingAlertResolution,
    TrackingAlertStatus,
    TrackingAlertType,
    TrackingAssociationStatus,
    ZoneAccess,
)
from app.repositories.companies import CompanyRepository
from app.repositories.locking import RowLock
from app.repositories.pagination import Page, paginate
from app.repositories.tracking import (
    LocationRepository,
    PlacedZone,
    TrackingAlertRepository,
    TrackingSettingsRepository,
)
from app.repositories.users import UserRepository
from app.repositories.visits import VisitRepository
from app.schemas.common import UserRef
from app.schemas.journeys import TrackingAlert as TrackingAlertOut
from app.schemas.journeys import (
    TrackingAlertAction,
    TrackingAlertBrief,
    TrackingAlertListQuery,
    TrackingAlertRef,
    TrackingAlertSummary,
)
from app.schemas.locations import VisitAccessAreas
from app.security.permissions import Capability, has_capability
from app.security.sessions import AuthContext
from app.services import audit
from app.services.access_areas import AccessAreaService
from app.services.audit import AuditAction, AuditEntity
from app.services.authorization import lock_company_for_change
from app.services.email_quota import EmailQuota, QuotaUnit
from app.services.journey_current import CurrentJourney, current_journeys, visit_summary
from app.services.scoping import FieldErrors, require_found
from app.services.tracking_provider import TrackingProvider
from app.services.tracking_rules import (
    SUMMARY_LATEST_LIMIT,
    AccessAreas,
    JourneyState,
    escalates,
    violation,
)
from app.services.tracking_settings import EffectiveSettings, effective_settings, journey_location

logger = logging.getLogger("app.tracking")
# Between a place's building, floor and zone in an e-mail (the API answers them apart).
PLACE_SEPARATOR = " \N{SINGLE RIGHT-POINTING ANGLE QUOTATION MARK} "


class AlertTrigger:
    """What opened (or escalated) an alert (`metadata.trigger` of its audit row)."""

    OBSERVATION = "OBSERVATION"  # a confirmed observation an ingested batch stored
    AREAS_CHANGED = "AREAS_CHANGED"  # a change of the visit's allowed areas


# ---- e-mails ---------------------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class AlertNotice:
    """What an opening or an escalation sent: its e-mails, and the budget that left some out."""

    jobs: tuple[DeliveryJob, ...] = ()
    limited_by: PolicyName | None = None


class AlertMail:
    """Queues an alert's e-mails in the caller's transaction, within the company's daily budget (B16-15).
    The caller commits, then schedules the jobs (`TrackingAlerts.jobs`)."""

    def __init__(self, emails: EmailService, quota: QuotaUnit) -> None:
        self.emails = emails
        self.quota = quota
        self.users = UserRepository(emails.db)

    def send(
        self,
        alert: TrackingAlert,
        *,
        visit: Visit,
        company: Company,
        place: PlacedZone,
        areas: VisitAccessAreas,
        settings: EffectiveSettings,
    ) -> AlertNotice:
        recipients: list[tuple[str, str | None, AlertLink, UUID | None]] = []
        seen: set[str] = set()
        for address in settings.alert_emails:
            if mailbox_key(address) not in seen:
                seen.add(mailbox_key(address))
                recipients.append((address, company.default_language, "journey", None))
        if settings.alert_notify_host:
            host = self.users.get_in_company(company.id, visit.host_id)
            if host is not None and host.is_active and mailbox_key(host.email) not in seen:
                recipients.append((host.email, host.preferred_language, "visit", host.id))
        if not recipients:
            return AlertNotice()
        facts = _facts(alert, visit=visit, place=place, areas=areas)
        jobs: list[DeliveryJob] = []
        for index, (address, language, link, user_id) in enumerate(recipients):
            # The first e-mail also takes the visit's notice (B16-25), both or neither: beyond the visit's
            # budget nothing of this opening or escalation is queued.
            limited_by = (
                self.quota.tracking_alert_notice(company.id, visit.id)
                if index == 0
                else self.quota.tracking_alert_email(company.id)
            )
            if limited_by is not None:
                return AlertNotice(tuple(jobs), limited_by)
            jobs.append(
                self.emails.queue_tracking_alert(
                    facts,
                    company=company,
                    to=address,
                    language=language,
                    link=link,
                    visit_id=visit.id,
                    recipient_user_id=user_id,
                )
            )
        return AlertNotice(tuple(jobs))


@dataclass(frozen=True, slots=True)
class AlertMailer:
    """Where a request's alert e-mails come from: its e-mail service and the application's budgets."""

    emails: EmailService
    quota: EmailQuota

    @contextmanager
    def unit(self) -> Iterator[AlertMail]:
        """An `AlertMail` whose budget slots count once the block ends without an error (after the
        caller's commit), and are given back otherwise (`EmailQuota.unit`)."""
        with self.quota.unit() as unit:
            yield AlertMail(self.emails, unit)


def _name(language: Language, name: str, name_ar: str | None) -> str:
    return (name_ar or name) if language is Language.AR else name


def _facts(alert: TrackingAlert, *, visit: Visit, place: PlacedZone, areas: VisitAccessAreas) -> AlertFacts:
    languages = (Language.AR, Language.EN)
    one_building = len({floor.building.id for floor in areas.floors}) <= 1

    def floor_label(language: Language, index: int) -> str:
        floor = areas.floors[index]
        name = _name(language, floor.name, floor.name_ar)
        if one_building:
            return name
        return _name(language, floor.building.name, floor.building.name_ar) + PLACE_SEPARATOR + name

    floors = {
        language: COMMA[language].join(floor_label(language, index) for index in range(len(areas.floors)))
        or None
        for language in languages
    }
    zones = {
        language: COMMA[language].join(_name(language, zone.name, zone.name_ar) for zone in areas.zones)
        or None
        for language in languages
    }
    return AlertFacts(
        alert_type=alert.type,
        simulated=alert.simulated,
        visitor_name=visit.visitor_name,
        visitor_company_name=visit.visitor_company_name,
        host_name=visit.host_name,
        place={
            language: PLACE_SEPARATOR.join(
                (
                    _name(language, place.building.name, place.building.name_ar),
                    _name(language, place.floor.name, place.floor.name_ar),
                    _name(language, place.zone.name, place.zone.name_ar),
                )
            )
            for language in languages
        },
        restricted=place.zone.access == ZoneAccess.RESTRICTED,
        seen_at=alert.last_seen_at,
        allowed_floors=floors,
        allowed_zones=zones,
    )


# ---- the engine ---------------------------------------------------------------------------------------


@dataclass
class _Evaluation:
    """One visit's evaluation: where its journey stands, the place, the areas, and what triggered it."""

    company: Company
    visit_id: UUID
    current: CurrentJourney
    place: PlacedZone
    areas: AccessAreas
    settings: EffectiveSettings
    trigger: str
    actor_id: UUID | None
    observed: bool  # a new observation (a batch's), not a re-evaluation of the same one
    now: datetime
    context: RequestContext
    visit: Visit | None = field(default=None)
    # Whether a violation may open or escalate the alert (B16-25): not for a host's change of the areas.
    raises: bool = field(default=True)


class TrackingAlerts:
    def __init__(self, db: Session, provider: TrackingProvider, *, mail: AlertMail | None = None) -> None:
        self.db = db
        self.provider = provider
        self.mail = mail
        self.alerts = TrackingAlertRepository(db)
        self.locations = LocationRepository(db)
        self.areas = AccessAreaService(db)
        self.visits = VisitRepository(db)
        # The e-mails queued by this instance, to schedule after the caller's commit.
        self.jobs: list[DeliveryJob] = []

    # ---- evaluation ---------------------------------------------------------------------------------

    def after_ingest(
        self,
        company: Company,
        stored: Mapping[UUID, Collection[UUID]],
        *,
        settings: EffectiveSettings,
        now: datetime,
        context: RequestContext,
    ) -> None:
        """Evaluate the visits whose confirmed observations with a location this batch stored (`stored`:
        visit ID -> the stored events' IDs). The batch holds their associations' locks."""
        if not stored or not settings.area_alerts_enabled:
            return
        visit_ids = sorted(stored, key=str)
        current = current_journeys(self.db, self.provider, company.id, visit_ids, settings, now=now)
        candidates = {
            visit_id: journey
            for visit_id, journey in current.items()
            if _evaluable(journey)
            and journey.location is not None
            and journey.location.id in stored[visit_id]
        }
        if not candidates:
            return
        places = self.locations.placed(company.id, {_zone_of(journey) for journey in candidates.values()})
        areas = self.areas.of_visits(company.id, list(candidates))
        for visit_id, journey in candidates.items():
            place = places.get(_zone_of(journey))
            if place is None:  # pragma: no cover - an event's zone exists (foreign key)
                continue
            self._evaluate(
                _Evaluation(
                    company=company,
                    visit_id=visit_id,
                    current=journey,
                    place=place,
                    areas=areas[visit_id],
                    settings=settings,
                    trigger=AlertTrigger.OBSERVATION,
                    actor_id=None,
                    observed=True,
                    now=now,
                    context=context,
                ),
                resolution=TrackingAlertResolution.RETURNED,
            )

    def after_areas_change(
        self,
        company: Company,
        visit: Visit,
        *,
        actor_id: UUID,
        raises: bool,
        now: datetime,
        context: RequestContext,
    ) -> None:
        """Re-evaluate the visit's current location under its new allowed areas: resolve its active alert
        (AREAS_CHANGED, the editor) when the location is now allowed; when it now violates them, open (or
        escalate) one only if `raises`, i.e. the editor is a receptionist or an administrator (B16-25). A
        host's change never raises an alert, nor e-mails one: the next confirmed observation does, as after
        a change of a zone's access level (B16-1). The caller holds the visit's row and its open
        association's."""
        settings = effective_settings(TrackingSettingsRepository(self.db).get(company.id))
        if not settings.area_alerts_enabled:
            return
        journey = current_journeys(self.db, self.provider, company.id, [visit.id], settings, now=now)[
            visit.id
        ]
        if not _evaluable(journey) or journey.location is None:
            return
        place = self.locations.placed(company.id, {_zone_of(journey)}).get(_zone_of(journey))
        if place is None:  # pragma: no cover - an event's zone exists (foreign key)
            return
        self._evaluate(
            _Evaluation(
                company=company,
                visit_id=visit.id,
                current=journey,
                place=place,
                areas=self.areas.of_visit(company.id, visit.id),
                settings=settings,
                trigger=AlertTrigger.AREAS_CHANGED,
                actor_id=actor_id,
                observed=False,
                now=now,
                context=context,
                visit=visit,
                raises=raises,
            ),
            resolution=TrackingAlertResolution.AREAS_CHANGED,
        )

    def resolve_for_check_out(
        self, visit: Visit, *, actor_id: UUID, now: datetime, context: RequestContext
    ) -> None:
        """The check-out's part (B16-8): the visit's active alert ends CHECKED_OUT, in the check-out's
        transaction, after its association (lock order, `repositories.tracking`)."""
        active = self.alerts.active_for_visit(visit.company_id, visit.id, lock=RowLock.UPDATE)
        if active is not None:
            self._resolve(
                active,
                resolution=TrackingAlertResolution.CHECKED_OUT,
                actor_id=actor_id,
                now=now,
                context=context,
            )

    def _evaluate(self, evaluation: _Evaluation, *, resolution: TrackingAlertResolution) -> None:
        place, location = evaluation.place, evaluation.current.location
        if location is None:  # pragma: no cover - checked by the callers
            return
        kind = violation(
            access=place.zone.access, zone_id=place.zone.id, floor_id=place.floor.id, areas=evaluation.areas
        )
        company_id = evaluation.company.id
        active = self.alerts.active_for_visit(company_id, evaluation.visit_id, lock=RowLock.UPDATE)
        if kind is None:
            if active is not None:
                self._resolve(
                    active,
                    resolution=resolution,
                    actor_id=evaluation.actor_id,
                    now=evaluation.now,
                    context=evaluation.context,
                )
            return
        if not evaluation.raises:
            # A host's change of the areas (B16-25): the alert stays as it is (or absent) until the next
            # confirmed observation, which a host cannot cause on demand.
            return
        if active is None:
            self._open(evaluation, kind)
            return
        escalated = escalates(active.type, kind)
        if evaluation.observed or escalated:
            _move(active, place, seen_at=location.observed_at)
            if evaluation.observed:
                active.observations += 1
            active.updated_at = evaluation.now
        if escalated:
            active.type = kind.value
            active.status = TrackingAlertStatus.OPEN.value
            # The summary names it among the newest from now on (B16-26); an alert escalates once at most.
            active.escalated_at = evaluation.now
            active.acknowledged_at = None
            active.acknowledged_by_id = None
            self.db.flush()
            notice = self._notify(evaluation, active)
            self._audit(
                evaluation,
                AuditAction.TRACKING_ALERT_ESCALATED,
                active,
                {"from_type": TrackingAlertType.UNAUTHORIZED_AREA, **_notified(notice)},
            )
            return
        self.db.flush()

    def _open(self, evaluation: _Evaluation, kind: TrackingAlertType) -> None:
        current, place, now = evaluation.current, evaluation.place, evaluation.now
        location = current.location
        association = current.association
        if location is None or association is None:  # pragma: no cover - checked by the callers
            return
        alert = TrackingAlert(
            company_id=evaluation.company.id,
            visit_id=evaluation.visit_id,
            association_id=association.id,
            type=kind.value,
            status=TrackingAlertStatus.OPEN.value,
            simulated=current.simulated,
            first_building_id=place.building.id,
            first_floor_id=place.floor.id,
            first_zone_id=place.zone.id,
            last_building_id=place.building.id,
            last_floor_id=place.floor.id,
            last_zone_id=place.zone.id,
            opened_at=location.observed_at,
            last_seen_at=location.observed_at,
            observations=1,
            created_at=now,
            updated_at=now,
        )
        self.db.add(alert)
        self.db.flush()
        notice = self._notify(evaluation, alert)
        self._audit(evaluation, AuditAction.TRACKING_ALERT_OPENED, alert, _notified(notice))

    def _resolve(
        self,
        alert: TrackingAlert,
        *,
        resolution: TrackingAlertResolution,
        actor_id: UUID | None,
        now: datetime,
        context: RequestContext,
        note: str | None = None,
    ) -> None:
        alert.status = TrackingAlertStatus.RESOLVED.value
        alert.resolved_at = now
        alert.resolved_by_id = actor_id
        alert.resolution = resolution.value
        if note is not None:
            alert.note = note
        alert.updated_at = now
        self.db.flush()
        audit.record(
            self.db,
            action=AuditAction.TRACKING_ALERT_RESOLVED,
            context=context,
            company_id=alert.company_id,
            actor_user_id=actor_id,
            entity_type=AuditEntity.VISIT,
            entity_id=alert.visit_id,
            metadata={"alert_id": alert.id, "resolution": resolution, "noted": note is not None},
        )

    def _notify(self, evaluation: _Evaluation, alert: TrackingAlert) -> AlertNotice:
        if self.mail is None:
            return AlertNotice()
        visit = evaluation.visit or self.visits.get(evaluation.company.id, evaluation.visit_id)
        if visit is None:  # pragma: no cover - an alert's visit exists (foreign key)
            return AlertNotice()
        notice = self.mail.send(
            alert,
            visit=visit,
            company=evaluation.company,
            place=evaluation.place,
            areas=self.areas.view(evaluation.company.id, visit.id),
            settings=evaluation.settings,
        )
        self.jobs.extend(notice.jobs)
        return notice

    def _audit(
        self,
        evaluation: _Evaluation,
        action: AuditAction,
        alert: TrackingAlert,
        extra: Mapping[str, object],
    ) -> None:
        audit.record(
            self.db,
            action=action,
            context=evaluation.context,
            company_id=alert.company_id,
            actor_user_id=evaluation.actor_id,
            entity_type=AuditEntity.VISIT,
            entity_id=alert.visit_id,
            metadata={
                "alert_id": alert.id,
                "type": alert.type,
                "building_id": alert.last_building_id,
                "floor_id": alert.last_floor_id,
                "zone_id": alert.last_zone_id,
                "simulated": alert.simulated,
                "trigger": evaluation.trigger,
                **extra,
            },
        )

    # ---- receptionists and administrators (B16-9) ------------------------------------------------------

    def acknowledge(
        self, auth: AuthContext, alert_id: UUID, data: TrackingAlertAction, context: RequestContext
    ) -> TrackingAlertOut:
        """OPEN -> ACKNOWLEDGED; an acknowledged alert is answered as it is; a resolved one is 409."""
        lock_company_for_change(self.db, auth, lock=RowLock.KEY_SHARE)
        alert = require_found(self.alerts.get(auth.company_id, alert_id, lock=RowLock.UPDATE))
        if alert.status == TrackingAlertStatus.RESOLVED:
            raise AlertResolved()
        if alert.status == TrackingAlertStatus.OPEN:
            now = app_time.now()
            alert.status = TrackingAlertStatus.ACKNOWLEDGED.value
            alert.acknowledged_at = now
            alert.acknowledged_by_id = auth.user_id
            if data.note is not None:
                alert.note = data.note
            alert.updated_at = now
            self.db.flush()
            audit.record(
                self.db,
                action=AuditAction.TRACKING_ALERT_ACKNOWLEDGED,
                context=context,
                company_id=auth.company_id,
                actor_user_id=auth.user_id,
                entity_type=AuditEntity.VISIT,
                entity_id=alert.visit_id,
                metadata={"alert_id": alert.id, "noted": data.note is not None},
            )
        view = self.views(auth, [alert])[0]
        self.db.commit()
        return view

    def resolve(
        self, auth: AuthContext, alert_id: UUID, data: TrackingAlertAction, context: RequestContext
    ) -> TrackingAlertOut:
        """OPEN or ACKNOWLEDGED -> RESOLVED (MANUAL); a resolved alert is answered as it is."""
        lock_company_for_change(self.db, auth, lock=RowLock.KEY_SHARE)
        alert = require_found(self.alerts.get(auth.company_id, alert_id, lock=RowLock.UPDATE))
        if alert.status != TrackingAlertStatus.RESOLVED:
            self._resolve(
                alert,
                resolution=TrackingAlertResolution.MANUAL,
                actor_id=auth.user_id,
                now=app_time.now(),
                context=context,
                note=data.note,
            )
        view = self.views(auth, [alert])[0]
        self.db.commit()
        return view

    # ---- reads ----------------------------------------------------------------------------------------

    def list_alerts(self, auth: AuthContext, query: TrackingAlertListQuery) -> Page[TrackingAlertOut]:
        company = require_found(CompanyRepository(self.db).get(auth.company_id))
        if query.visit_id is not None:
            errors = FieldErrors()
            errors.require(self.visits.get(company.id, query.visit_id), "visit_id")
            errors.raise_if_any()
        if query.scope == "day":
            day = query.day or local_date(app_time.now(), company.timezone)
            start, end = company_day_bounds(day, company.timezone)
            statement = self.alerts.listed(
                company.id, active_only=False, opened_from=start, opened_before=end, visit_id=query.visit_id
            )
        else:
            statement = self.alerts.listed(company.id, active_only=True, visit_id=query.visit_id)
        page = paginate(self.db, statement, page=query.page, page_size=query.page_size)
        return Page(
            items=self.views(auth, page.items), page=page.page, page_size=page.page_size, total=page.total
        )

    def summary(self, auth: AuthContext) -> TrackingAlertSummary:
        """Counts and the latest OPEN alerts, the newest opened or escalated first (B16-26); all zeros while
        tracking is not allowed for the company or the deployment has no provider (B16-11)."""
        settings = effective_settings(TrackingSettingsRepository(self.db).get(auth.company_id))
        if not self.provider.enabled or not settings.allowed:
            return TrackingAlertSummary(open=0, active=0, latest=[])
        counts = self.alerts.counts(auth.company_id)
        latest = self.alerts.latest_open(auth.company_id, limit=SUMMARY_LATEST_LIMIT) if counts.open else []
        visits = self._visits(auth.company_id, {alert.visit_id for alert in latest})
        places = self.locations.placed(auth.company_id, {alert.last_zone_id for alert in latest})
        return TrackingAlertSummary(
            open=counts.open,
            active=counts.active,
            latest=[
                TrackingAlertBrief(
                    id=alert.id,
                    type=TrackingAlertType(alert.type),
                    visit_id=alert.visit_id,
                    visitor_name=visits[alert.visit_id].visitor_name,
                    location=journey_location(places[alert.last_zone_id]),
                    opened_at=alert.opened_at,
                    escalated_at=alert.escalated_at,
                    simulated=alert.simulated,
                )
                for alert in latest
            ],
        )

    def views(self, auth: AuthContext, alerts: Sequence[TrackingAlert]) -> list[TrackingAlertOut]:
        """The API's alerts, in a fixed number of queries whatever their number."""
        if not alerts:
            return []
        company_id = auth.company_id
        visits = self._visits(company_id, {alert.visit_id for alert in alerts})
        places = self.locations.placed(
            company_id, {zone for alert in alerts for zone in (alert.first_zone_id, alert.last_zone_id)}
        )
        areas = self.areas.views(company_id, sorted(visits, key=str))
        users = UserRepository(self.db).summaries(
            company_id,
            {
                user_id
                for alert in alerts
                for user_id in (alert.acknowledged_by_id, alert.resolved_by_id)
                if user_id is not None
            },
        )
        tracker = has_capability(auth.roles, Capability.TRACK_VISITS)

        def user(user_id: UUID | None) -> UserRef | None:
            if user_id is None:
                return None
            summary = users.get(user_id)
            return UserRef(id=user_id, full_name=summary.full_name if summary is not None else "")

        return [
            TrackingAlertOut(
                id=alert.id,
                type=TrackingAlertType(alert.type),
                status=TrackingAlertStatus(alert.status),
                simulated=alert.simulated,
                visit=visit_summary(visits[alert.visit_id]),
                first_location=journey_location(places[alert.first_zone_id]),
                last_location=journey_location(places[alert.last_zone_id]),
                opened_at=alert.opened_at,
                last_seen_at=alert.last_seen_at,
                escalated_at=alert.escalated_at,
                observations=alert.observations,
                access_areas=areas[alert.visit_id],
                acknowledged_at=alert.acknowledged_at,
                acknowledged_by=user(alert.acknowledged_by_id),
                resolved_at=alert.resolved_at,
                resolved_by=user(alert.resolved_by_id),
                resolution=TrackingAlertResolution(alert.resolution) if alert.resolution else None,
                note=alert.note,
                can_act=tracker and alert.status != TrackingAlertStatus.RESOLVED,
            )
            for alert in alerts
        ]

    def refs(self, company_id: UUID, visit_ids: Collection[UUID]) -> dict[UUID, TrackingAlertRef]:
        """Each visit's active alert, as a list row names it."""
        return {
            visit_id: TrackingAlertRef(
                id=alert.id, type=TrackingAlertType(alert.type), status=TrackingAlertStatus(alert.status)
            )
            for visit_id, alert in self.alerts.active_for_visits(company_id, visit_ids).items()
        }

    def _visits(self, company_id: UUID, visit_ids: Collection[UUID]) -> dict[UUID, Visit]:
        if not visit_ids:
            return {}
        rows = self.db.scalars(
            select(Visit).where(Visit.company_id == company_id, Visit.id.in_(list(visit_ids)))
        )
        return {visit.id: visit for visit in rows}


def _evaluable(journey: CurrentJourney) -> bool:
    """A journey whose location an alert may come from (B16-5): ACTIVE, of an ACTIVE association."""
    return (
        journey.state is JourneyState.ACTIVE
        and journey.association is not None
        and journey.association.status == TrackingAssociationStatus.ACTIVE
    )


def _zone_of(journey: CurrentJourney) -> UUID:
    location = journey.location
    if location is None or location.zone_id is None:  # pragma: no cover - checked by the callers
        raise ValueError("a confirmed observation with a location is needed")
    return location.zone_id


def _move(alert: TrackingAlert, place: PlacedZone, *, seen_at: datetime) -> None:
    alert.last_building_id = place.building.id
    alert.last_floor_id = place.floor.id
    alert.last_zone_id = place.zone.id
    alert.last_seen_at = max(seen_at, alert.last_seen_at)


def _notified(notice: AlertNotice) -> dict[str, object]:
    return {"notified": len(notice.jobs), "notice_limited_by": notice.limited_by}
