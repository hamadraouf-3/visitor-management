"""The tracking provider boundary (Phase 15, B15-1, B15-7, docs/visitor-tracking-integration.md).

The application talks to a tracking provider through `TrackingProvider`, a typed protocol of three
calls, and the provider talks to the application through the ingestion endpoint
(`POST /api/v1/tracking/events`). Two implementations exist, and no other:

* `DisabledProvider` (`TRACKING_PROVIDER=disabled`, the default everywhere and production's value):
  nothing is enrolled, the ingestion endpoint answers 404, every journey is DISABLED.
* `SimulatorProvider` (`TRACKING_PROVIDER=simulator`, refused in production): enrolls at once by sending
  an ENROLLED event **through the same ingestion service** a real provider's events go through, with
  `model_version` "simulator". `python -m app.cli simulate-journey` sends synthetic observations the
  same way. Everything it makes is marked Simulated.

**No real adapter exists.** Gate 0 found no tracking model, code, interface or documentation
(docs/visitor-tracking-model-assessment.md): a real adapter is BLOCKED BY ENVIRONMENT. Nothing here
claims that live tracking works.

**Enrollment is a binding request**, never an image: "the person at camera C now is association A"
(`enroll(ref, provider_camera_id, at)`). The provider does any capture on its side, under its own policy.
The application never receives, stores or logs an image, a crop, an embedding or a template (B15-7).

The calls are made **after** the application's own change has committed (B15-18), so no database lock is held
while a provider answers; a failure is counted in the company's health record and never undoes the
change (an association ended in the application stays ended: its later events are rejected).
"""

from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Protocol
from uuid import UUID, uuid4

from app.core.config import Settings
from app.services.tracking_rules import IngestEventType

SIMULATOR_MODEL_VERSION = "simulator"


class ProviderError(Exception):
    """A provider call that did not succeed. Its message never carries a ref, a key or a payload."""


@dataclass(frozen=True, slots=True)
class ProviderHealth:
    reachable: bool


@dataclass(frozen=True, slots=True)
class IncomingEvent:
    """One event as the ingestion service takes it, from the HTTP endpoint or from the simulator."""

    provider_event_id: str
    type: IngestEventType
    observed_at: datetime
    association_ref: str | None = None
    camera_id: str | None = None
    match: str | None = None
    confidence: float | None = None
    model_version: str | None = None


class TrackingProvider(Protocol):
    """What the application asks of a tracking provider. `company_id` names the tenant whose key the provider
    must use for the association's events (the ref alone tells the provider nothing, B15-7)."""

    @property
    def name(self) -> str:
        """The deployment's provider name (`TRACKING_PROVIDER`), stored on associations and events."""
        ...

    @property
    def enabled(self) -> bool: ...

    def enroll(self, *, company_id: UUID, ref: str, provider_camera_id: str, at: datetime) -> None:
        """Bind the person at `provider_camera_id` at `at` to `ref`. The provider answers later with an
        ENROLLED or ENROLLMENT_FAILED event; raises ProviderError when the request itself fails."""
        ...

    def revoke(self, *, company_id: UUID, ref: str) -> None:
        """Stop tracking `ref` and forget it. Best effort: raises ProviderError when it fails."""
        ...

    def health(self) -> ProviderHealth: ...


class DisabledProvider:
    """`TRACKING_PROVIDER=disabled`: nothing is ever sent anywhere."""

    name = "disabled"
    enabled = False

    def enroll(self, *, company_id: UUID, ref: str, provider_camera_id: str, at: datetime) -> None:
        raise ProviderError("the tracking provider is disabled")

    def revoke(self, *, company_id: UUID, ref: str) -> None:
        return None  # nothing was ever enrolled with it

    def health(self) -> ProviderHealth:
        return ProviderHealth(reachable=False)


# Ingests events for a company as if its provider had sent them (`TrackingIngestion.ingest_simulated`).
type EventSink = Callable[[UUID, Sequence[IncomingEvent]], None]


class SimulatorProvider:
    """`TRACKING_PROVIDER=simulator` (development and E2E only; production refuses it, B15-1). It runs in
    the API process: enrolling sends the ENROLLED event at once through the ingestion service; revoking
    has nothing to forget. Its events carry `model_version` "simulator" and its associations are marked
    Simulated."""

    name = "simulator"
    enabled = True

    def __init__(self, sink: EventSink) -> None:
        self._sink = sink

    def enroll(self, *, company_id: UUID, ref: str, provider_camera_id: str, at: datetime) -> None:
        event = IncomingEvent(
            # Random, like the ref: nothing of the ref goes into it.
            provider_event_id=f"sim-enroll-{uuid4().hex}",
            type=IngestEventType.ENROLLED,
            observed_at=at,
            association_ref=ref,
            camera_id=provider_camera_id,
            model_version=SIMULATOR_MODEL_VERSION,
        )
        self._sink(company_id, (event,))

    def revoke(self, *, company_id: UUID, ref: str) -> None:
        return None  # the simulator keeps nothing about a ref

    def health(self) -> ProviderHealth:
        return ProviderHealth(reachable=True)


def create_tracking_provider(settings: Settings) -> TrackingProvider:
    """The deployment's provider (`TRACKING_PROVIDER`). Production never reaches the simulator: settings
    validation refuses it there."""
    if settings.tracking_provider == "simulator":
        if settings.is_production:  # pragma: no cover - refused by settings validation first
            raise ProviderError("the simulator is not available in production")
        from app.services.tracking_ingestion import ingest_simulated

        return SimulatorProvider(ingest_simulated)
    return DisabledProvider()
