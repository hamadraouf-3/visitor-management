"""The Visitor Journey's pure rules (Phase 15, `app.services.tracking_rules`): the journey state, what
counts as confirmed, references and keys, the association's expiry, the provider boundary."""

import hashlib
import re
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest

from app.core.config import Settings
from app.models.enums import JourneyEventType, TrackingAssociationStatus
from app.services.tracking_provider import (
    DisabledProvider,
    ProviderError,
    SimulatorProvider,
    create_tracking_provider,
)
from app.services.tracking_rules import (
    ASSOCIATION_MAX_LIFETIME,
    CONFLICT_WINDOW,
    PENDING_TIMEOUT,
    PROVIDER_CONTACT_TIMEOUT,
    AssociationFacts,
    JourneyState,
    ProviderOperation,
    Sighting,
    active_expiry,
    freshness_seconds,
    is_confirmed,
    journey_state,
    key_digest,
    new_key,
    new_ref,
    pending_expiry,
    presented_key,
    provider_failure_reason,
    provider_operation_of,
)

NOW = datetime(2026, 10, 20, 9, 0, tzinfo=UTC)
ACTIVE = AssociationFacts(
    TrackingAssociationStatus.ACTIVE, NOW + timedelta(hours=2), NOW - timedelta(minutes=30)
)
STALE_AFTER = timedelta(minutes=15)


def activated(minutes_ago: float) -> AssociationFacts:
    return AssociationFacts(
        TrackingAssociationStatus.ACTIVE, NOW + timedelta(hours=2), NOW - timedelta(minutes=minutes_ago)
    )


def sighting(
    minutes_ago: float = 1,
    *,
    match: str | None = "CONFIRMED",
    confidence: float | None = 0.9,
    lost: bool = False,
) -> Sighting:
    return Sighting(
        event_id=uuid4(),
        type=JourneyEventType.LOST if lost else JourneyEventType.OBSERVED,
        observed_at=NOW - timedelta(minutes=minutes_ago),
        floor_id=uuid4(),
        match=None if lost else match,
        confidence=confidence,
    )


def ago(minutes: float) -> datetime:
    return NOW - timedelta(minutes=minutes)


def state(**overrides: object) -> JourneyState:
    """The state of an ACTIVE association activated 30 minutes ago whose latest sighting is a confirmed
    observation a minute ago, unless `overrides` say otherwise."""
    arguments: dict[str, object] = {
        "tracking_on": True,
        "association": ACTIVE,
        "last_contact_at": NOW - timedelta(minutes=1),
        "latest_sighting": sighting(),
        "latest_confirmed_at": ago(1),
        "conflict": False,
        "threshold": 0.8,
        "stale_after": STALE_AFTER,
        "now": NOW,
    }
    arguments.update(overrides)
    return journey_state(**arguments)  # type: ignore[arg-type]


NOTHING_SEEN: dict[str, object] = {"latest_sighting": None, "latest_confirmed_at": None}


@pytest.mark.parametrize(
    ("overrides", "expected"),
    [
        ({}, JourneyState.ACTIVE),
        ({"tracking_on": False}, JourneyState.DISABLED),
        ({"association": None}, JourneyState.NOT_ENROLLED),
        (
            {"association": AssociationFacts(TrackingAssociationStatus.PENDING, NOW + timedelta(hours=1))},
            JourneyState.PENDING,
        ),
        (
            {"association": AssociationFacts(TrackingAssociationStatus.ENDED, NOW + timedelta(hours=1))},
            JourneyState.ENDED,
        ),
        # Expired but not yet swept: already ENDED on the read.
        (
            {"association": AssociationFacts(TrackingAssociationStatus.ACTIVE, NOW, ago(60))},
            JourneyState.ENDED,
        ),
        ({"last_contact_at": None}, JourneyState.UNAVAILABLE),
        (
            {"last_contact_at": NOW - PROVIDER_CONTACT_TIMEOUT - timedelta(seconds=1)},
            JourneyState.UNAVAILABLE,
        ),
        ({"last_contact_at": NOW - PROVIDER_CONTACT_TIMEOUT}, JourneyState.ACTIVE),
        # Just activated, nothing seen yet: ACTIVE (no location: "Unknown") until the stale threshold
        # has passed since the activation (the lead's decision, B15-12).
        ({**NOTHING_SEEN, "association": activated(1)}, JourneyState.ACTIVE),
        ({**NOTHING_SEEN, "association": activated(15)}, JourneyState.ACTIVE),
        ({**NOTHING_SEEN, "association": activated(16)}, JourneyState.STALE),
        # Freshness runs from the latest confirmed observation once there is one.
        ({"latest_sighting": sighting(16), "latest_confirmed_at": ago(16)}, JourneyState.STALE),
        ({"latest_sighting": sighting(15), "latest_confirmed_at": ago(15)}, JourneyState.ACTIVE),
        (
            {"latest_sighting": sighting(16), "latest_confirmed_at": ago(16), "association": activated(1)},
            JourneyState.STALE,
        ),
        ({"latest_sighting": sighting(lost=True)}, JourneyState.STALE),
        ({"latest_sighting": sighting(lost=True), "association": activated(1)}, JourneyState.STALE),
        # A fresh observation that is not confirmed, whatever the freshness anchor says.
        (
            {"latest_sighting": sighting(match="UNCERTAIN"), "latest_confirmed_at": None},
            JourneyState.UNCERTAIN,
        ),
        (
            {"latest_sighting": sighting(match="UNCERTAIN"), "latest_confirmed_at": ago(5)},
            JourneyState.UNCERTAIN,
        ),
        (
            {"latest_sighting": sighting(confidence=0.79), "latest_confirmed_at": ago(20)},
            JourneyState.UNCERTAIN,
        ),
        ({"latest_sighting": sighting(confidence=0.8)}, JourneyState.ACTIVE),
        ({"latest_sighting": sighting(confidence=None), "latest_confirmed_at": None}, JourneyState.UNCERTAIN),
        ({"threshold": None, "latest_confirmed_at": None}, JourneyState.UNCERTAIN),
        ({"conflict": True}, JourneyState.UNCERTAIN),
        # An old unconfirmed observation: nothing confirmed for long, so STALE.
        (
            {"latest_sighting": sighting(30, match="UNCERTAIN"), "latest_confirmed_at": None},
            JourneyState.STALE,
        ),
        (
            {"latest_sighting": sighting(20, match="UNCERTAIN"), "latest_confirmed_at": ago(25)},
            JourneyState.STALE,
        ),
        # The provider's outage outranks everything an ACTIVE association could show.
        ({"last_contact_at": None, "latest_sighting": sighting(match="UNCERTAIN")}, JourneyState.UNAVAILABLE),
        # A disabled company shows DISABLED whatever its associations hold.
        ({"tracking_on": False, "association": None}, JourneyState.DISABLED),
    ],
)
def test_journey_state(overrides: dict[str, object], expected: JourneyState) -> None:
    assert state(**overrides) is expected


def test_only_a_confirmed_match_at_or_above_a_set_threshold_counts() -> None:
    assert is_confirmed("CONFIRMED", 0.8, 0.8)
    assert not is_confirmed("CONFIRMED", 0.79, 0.8)
    assert not is_confirmed("CONFIRMED", None, 0.8)
    assert not is_confirmed("CONFIRMED", 1.0, None)  # no threshold: nothing is confirmed
    assert not is_confirmed("UNCERTAIN", 1.0, 0.1)
    assert not is_confirmed(None, 1.0, 0.1)


def test_the_placeholder_constants() -> None:
    """Placeholders pending real footage (B15-16): changing one is a decision to record."""
    assert timedelta(seconds=60) == CONFLICT_WINDOW
    assert timedelta(minutes=5) == PROVIDER_CONTACT_TIMEOUT
    assert timedelta(hours=12) == ASSOCIATION_MAX_LIFETIME
    assert timedelta(minutes=10) == PENDING_TIMEOUT


def test_freshness() -> None:
    assert freshness_seconds(None, now=NOW) is None
    assert freshness_seconds(NOW - timedelta(minutes=4, seconds=1), now=NOW) == 241
    assert freshness_seconds(NOW + timedelta(seconds=30), now=NOW) == 0  # a provider clock slightly ahead


def test_refs_are_random_and_say_nothing() -> None:
    refs = {new_ref() for _ in range(200)}
    assert len(refs) == 200
    for ref in refs:
        assert re.fullmatch(r"trk_[a-z2-7]{32}", ref)  # 160 bits


def test_keys_are_shown_once_and_stored_as_digests() -> None:
    made = new_key()
    assert re.fullmatch(r"vtk_[A-Za-z0-9_-]{43}", made.secret)
    assert made.prefix == made.secret[:8] and made.digest == hashlib.sha256(made.secret.encode()).hexdigest()
    assert key_digest(made.secret) == made.digest and made.secret not in made.digest
    assert presented_key(f"Bearer {made.secret}") == made.secret
    assert presented_key(f"  Bearer {made.secret}  ") == made.secret
    for header in (
        None,
        "",
        made.secret,
        f"bearer {made.secret}",
        f"Bearer {made.secret}x",
        "Bearer vtk_short",
    ):
        assert presented_key(header) is None


def test_a_pending_association_expires_after_ten_minutes_an_active_one_after_twelve_hours() -> None:
    """B15-34 (after the independent review): the visit's schedule no longer bounds it."""
    assert pending_expiry(NOW) == NOW + timedelta(minutes=10)
    assert active_expiry(NOW) == NOW + timedelta(hours=12)


def test_provider_failure_reasons() -> None:
    assert provider_failure_reason(ProviderOperation.REVOKE) == "PROVIDER_REVOKE_FAILED"
    assert provider_operation_of("PROVIDER_ENROLL_FAILED") is ProviderOperation.ENROLL
    assert provider_operation_of("UNKNOWN_CAMERA") is None
    assert provider_operation_of("PROVIDER_OTHER_FAILED") is None


def test_the_provider_follows_the_setting() -> None:
    base = {"_env_file": None, "app_env": "development", "database_url": "postgresql://u:p@h/d"}
    assert isinstance(create_tracking_provider(Settings(**base)), DisabledProvider)  # type: ignore[arg-type]
    simulator = create_tracking_provider(Settings(**base, tracking_provider="simulator"))  # type: ignore[arg-type]
    assert isinstance(simulator, SimulatorProvider) and simulator.name == "simulator" and simulator.enabled


def test_the_disabled_provider_sends_nothing() -> None:
    provider = DisabledProvider()
    assert provider.enabled is False and provider.health().reachable is False
    with pytest.raises(ProviderError):
        provider.enroll(company_id=uuid4(), ref=new_ref(), provider_camera_id="cam", at=NOW)
    assert provider.revoke(company_id=uuid4(), ref=new_ref()) is None


def test_the_simulator_enrolls_through_the_sink_with_a_random_event_id() -> None:
    received: list[tuple[object, object]] = []
    provider = SimulatorProvider(lambda company_id, events: received.append((company_id, events)))
    company, ref = uuid4(), new_ref()
    provider.enroll(company_id=company, ref=ref, provider_camera_id="cam-reception", at=NOW)
    [(target, events)] = received
    [event] = events  # type: ignore[misc]
    assert target == company and event.type == "ENROLLED" and event.association_ref == ref
    assert event.camera_id == "cam-reception" and event.model_version == "simulator"
    assert ref.removeprefix("trk_")[:8] not in event.provider_event_id
