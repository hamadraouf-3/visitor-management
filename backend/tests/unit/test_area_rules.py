"""The allowed-areas rule of Phase 16 without a database (B16-4, B16-8): which confirmed location violates a
visit's allowed areas and how, when an active alert escalates, and who changes a visit's areas."""

import uuid

import pytest

from app.models.enums import Role, TrackingAlertType, VisitStatus, ZoneAccess
from app.services import visit_rules
from app.services.tracking_rules import NOT_SET, AccessAreas, escalates, is_allowed, violation

FLOOR_2, FLOOR_4 = uuid.uuid4(), uuid.uuid4()
ZONE_ON_2, ZONE_ON_4 = uuid.uuid4(), uuid.uuid4()

FLOORS = AccessAreas(floor_ids=frozenset({FLOOR_2}))
ZONES = AccessAreas(zone_ids=frozenset({ZONE_ON_4}))
BOTH = AccessAreas(floor_ids=frozenset({FLOOR_2}), zone_ids=frozenset({ZONE_ON_4}))

UNAUTHORIZED, RESTRICTED = TrackingAlertType.UNAUTHORIZED_AREA, TrackingAlertType.RESTRICTED_AREA


@pytest.mark.parametrize(
    ("access", "zone", "floor", "areas", "expected"),
    [
        # COMMON: never, whatever the areas.
        (ZoneAccess.COMMON, ZONE_ON_4, FLOOR_4, NOT_SET, None),
        (ZoneAccess.COMMON, ZONE_ON_4, FLOOR_4, FLOORS, None),
        (ZoneAccess.COMMON, ZONE_ON_2, FLOOR_2, ZONES, None),
        # STANDARD: allowed on an allowed floor or as a listed zone; otherwise only while the areas are set.
        (ZoneAccess.STANDARD, ZONE_ON_2, FLOOR_2, FLOORS, None),
        (ZoneAccess.STANDARD, ZONE_ON_4, FLOOR_4, FLOORS, UNAUTHORIZED),
        (ZoneAccess.STANDARD, ZONE_ON_4, FLOOR_4, ZONES, None),  # the zone is listed
        (ZoneAccess.STANDARD, ZONE_ON_2, FLOOR_2, ZONES, UNAUTHORIZED),  # set, and neither names it
        (ZoneAccess.STANDARD, ZONE_ON_4, FLOOR_4, BOTH, None),
        (ZoneAccess.STANDARD, ZONE_ON_4, FLOOR_4, NOT_SET, None),  # not set: STANDARD never alerts
        (ZoneAccess.STANDARD, ZONE_ON_2, FLOOR_2, NOT_SET, None),
        # RESTRICTED: only a listed zone; an allowed floor is not enough; not set still alerts.
        (ZoneAccess.RESTRICTED, ZONE_ON_4, FLOOR_4, ZONES, None),
        (ZoneAccess.RESTRICTED, ZONE_ON_4, FLOOR_4, BOTH, None),
        (ZoneAccess.RESTRICTED, ZONE_ON_2, FLOOR_2, FLOORS, RESTRICTED),
        (ZoneAccess.RESTRICTED, ZONE_ON_2, FLOOR_2, BOTH, RESTRICTED),
        (ZoneAccess.RESTRICTED, ZONE_ON_2, FLOOR_2, NOT_SET, RESTRICTED),
        (ZoneAccess.RESTRICTED, ZONE_ON_4, FLOOR_4, FLOORS, RESTRICTED),
    ],
)
def test_the_violation_table(
    access: ZoneAccess,
    zone: uuid.UUID,
    floor: uuid.UUID,
    areas: AccessAreas,
    expected: TrackingAlertType | None,
) -> None:
    assert violation(access=access, zone_id=zone, floor_id=floor, areas=areas) is expected
    assert is_allowed(access=access.value, zone_id=zone, floor_id=floor, areas=areas) is (expected is None)


def test_areas_are_set_by_a_floor_or_a_zone() -> None:
    assert not NOT_SET.is_set
    assert FLOORS.is_set and ZONES.is_set and BOTH.is_set
    assert AccessAreas() == NOT_SET


@pytest.mark.parametrize(
    ("current", "new", "expected"),
    [
        (UNAUTHORIZED, RESTRICTED, True),
        (UNAUTHORIZED.value, RESTRICTED, True),  # as stored
        (UNAUTHORIZED, UNAUTHORIZED, False),
        (RESTRICTED, RESTRICTED, False),
        (RESTRICTED, UNAUTHORIZED, False),  # never back down
    ],
)
def test_only_a_restricted_violation_escalates_an_unauthorized_alert(
    current: TrackingAlertType | str, new: TrackingAlertType, expected: bool
) -> None:
    assert escalates(current, new) is expected


HOST, OTHER = uuid.uuid4(), uuid.uuid4()


@pytest.mark.parametrize(
    ("roles", "user", "status", "expected"),
    [
        ({Role.SYSTEM_ADMIN}, OTHER, VisitStatus.SCHEDULED, True),
        ({Role.RECEPTIONIST}, OTHER, VisitStatus.CHECKED_IN, True),
        ({Role.EMPLOYEE}, HOST, VisitStatus.SCHEDULED, True),  # the visit's host
        ({Role.EMPLOYEE}, HOST, VisitStatus.CHECKED_IN, True),
        ({Role.EMPLOYEE}, OTHER, VisitStatus.SCHEDULED, False),  # another host's visit
        ({Role.MANAGEMENT}, OTHER, VisitStatus.SCHEDULED, False),  # management reads
        ({Role.MANAGEMENT}, HOST, VisitStatus.SCHEDULED, False),  # without a host role
        ({Role.MANAGEMENT, Role.EMPLOYEE}, HOST, VisitStatus.SCHEDULED, True),
        ({Role.SYSTEM_ADMIN}, OTHER, VisitStatus.CHECKED_OUT, False),
        ({Role.RECEPTIONIST}, OTHER, VisitStatus.CANCELLED, False),
        ({Role.EMPLOYEE}, HOST, VisitStatus.NO_SHOW, False),
    ],
)
def test_who_changes_a_visit_s_allowed_areas(
    roles: set[Role], user: uuid.UUID, status: VisitStatus, expected: bool
) -> None:
    caller = visit_rules.Caller(user_id=user, roles=frozenset(roles))
    assert visit_rules.can_edit_access_areas(caller, status=status.value, host_id=HOST) is expected
