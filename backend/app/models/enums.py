"""Domain enumerations stored as VARCHAR + CHECK (contract §4) and exposed in the API (§8.1)."""

from enum import StrEnum


class Role(StrEnum):
    SYSTEM_ADMIN = "SYSTEM_ADMIN"
    EMPLOYEE = "EMPLOYEE"
    RECEPTIONIST = "RECEPTIONIST"
    MANAGEMENT = "MANAGEMENT"


class VisitStatus(StrEnum):
    SCHEDULED = "SCHEDULED"
    CHECKED_IN = "CHECKED_IN"
    CHECKED_OUT = "CHECKED_OUT"
    CANCELLED = "CANCELLED"
    NO_SHOW = "NO_SHOW"


class CheckInMethod(StrEnum):
    QR = "QR"
    MANUAL = "MANUAL"
    OVERRIDE = "OVERRIDE"
    WALK_IN = "WALK_IN"


class CheckOutMethod(StrEnum):
    QR = "QR"
    MANUAL = "MANUAL"
    CORRECTED = "CORRECTED"
    BULK = "BULK"


class PassRevokeReason(StrEnum):
    ROTATED = "ROTATED"
    VISIT_CANCELLED = "VISIT_CANCELLED"
    VISIT_COMPLETED = "VISIT_COMPLETED"
    VISITOR_EMAIL_CHANGED = "VISITOR_EMAIL_CHANGED"


class EmailKind(StrEnum):
    VISITOR_INVITATION = "VISITOR_INVITATION"
    VISIT_RESCHEDULED = "VISIT_RESCHEDULED"
    VISIT_CANCELLED = "VISIT_CANCELLED"
    HOST_ARRIVAL = "HOST_ARRIVAL"
    PASSWORD_RESET = "PASSWORD_RESET"
    PASSWORD_CHANGED = "PASSWORD_CHANGED"  # security notice after a change or reset (SEC-06)
    # Security notice to a company's other administrators when the platform owner adds an administrator
    # or sends one a reset link (revision 0014, B11-43).
    PLATFORM_ACTION_NOTICE = "PLATFORM_ACTION_NOTICE"
    # The host's e-mails of a scheduled visit: a new visit, its new time, its cancellation. Each carries
    # the visit as an event of the host's calendar (revision 0016, Phase 14, B14-1).
    HOST_VISIT_SCHEDULED = "HOST_VISIT_SCHEDULED"
    HOST_VISIT_RESCHEDULED = "HOST_VISIT_RESCHEDULED"
    HOST_VISIT_CANCELLED = "HOST_VISIT_CANCELLED"
    # The short e-mail that follows a visitor's invitation and carries the visit as an event of the
    # visitor's calendar, without the pass (revision 0016, B14-10). Its words are the invitation's.
    VISITOR_CALENDAR = "VISITOR_CALENDAR"
    # A visitor seen outside the visit's allowed areas (revision 0019, Phase 16, B16-14): to the host and
    # the company's alert addresses, on an alert's opening and escalation. Product texts, not editable,
    # like the security e-mails (B11-21).
    TRACKING_ALERT = "TRACKING_ALERT"


# The kinds whose texts a company's administrator may edit (revision 0013, B11-20; the host's three since
# revision 0016, B14-2). The security e-mails (PASSWORD_RESET, PASSWORD_CHANGED, PLATFORM_ACTION_NOTICE)
# keep the product's texts: B11-21.
EDITABLE_EMAIL_KINDS: tuple[EmailKind, ...] = (
    EmailKind.VISITOR_INVITATION,
    EmailKind.VISIT_RESCHEDULED,
    EmailKind.VISIT_CANCELLED,
    EmailKind.HOST_ARRIVAL,
    EmailKind.HOST_VISIT_SCHEDULED,
    EmailKind.HOST_VISIT_RESCHEDULED,
    EmailKind.HOST_VISIT_CANCELLED,
)


class TemplateField(StrEnum):
    """An editable text of an e-mail (B11-20). Which kind has which is `app.email.editable.EDITABLE`."""

    SUBJECT = "subject"
    HEADING = "heading"
    GREETING = "greeting"
    INTRO = "intro"
    BUTTON = "button"
    CLOSING = "closing"
    FOOTER_NOTE = "footer_note"


class Language(StrEnum):
    """A user's interface and e-mail language (Phase 10, B10-1). Arabic is the product's default."""

    AR = "ar"
    EN = "en"


DEFAULT_LANGUAGE = Language.AR


class BrandAssetKind(StrEnum):
    """A company's brand images (Phase 12, B12-1), each a PNG the platform owner uploads."""

    LOGO = "logo"  # on light surfaces: the sign-in card, the e-mails, the pass page, print
    LOGO_DARK = "logo_dark"  # optional: on the coloured shell and dark surfaces
    ICON = "icon"  # square: the browser tab and the installed app


class EmailStatus(StrEnum):
    PENDING = "PENDING"
    SENT = "SENT"
    FAILED = "FAILED"


class EventMethod(StrEnum):
    """The iTIP method of the calendar event an e-mail carried (revision 0017, Phase 14, B14-26): which
    calendars were sent a visit's event and which had it taken out again."""

    REQUEST = "REQUEST"
    CANCEL = "CANCEL"


def sql_in_list(enum_type: type[StrEnum]) -> str:
    """`'A', 'B', ...` for CHECK constraints; values are compile-time constants, never user input."""
    return ", ".join(f"'{member.value}'" for member in enum_type)


# ---- the Visitor Journey (revision 0018, Phase 15, docs/visitor-journey-design.md) -------------------


class TrackingAssociationStatus(StrEnum):
    """A visit's tracking association: PENDING until the provider confirms the enrollment (ENROLLED),
    ACTIVE until it ends; an ENDED association never becomes active again."""

    PENDING = "PENDING"
    ACTIVE = "ACTIVE"
    ENDED = "ENDED"


class TrackingEndReason(StrEnum):
    CHECKED_OUT = "CHECKED_OUT"
    REVOKED = "REVOKED"
    EXPIRED = "EXPIRED"
    ENROLLMENT_FAILED = "ENROLLMENT_FAILED"
    # Reserved: a checked-in visit cannot be cancelled (`visit_rules`), so no association ends this way
    # today (B15-15).
    VISIT_CANCELLED = "VISIT_CANCELLED"


class JourneyEventType(StrEnum):
    """What a stored journey event is (the provider's ENROLLMENT_FAILED and HEARTBEAT are not stored)."""

    ENROLLED = "ENROLLED"
    OBSERVED = "OBSERVED"
    LOST = "LOST"


class ObservationMatch(StrEnum):
    """The provider's own judgement of an observation."""

    CONFIRMED = "CONFIRMED"
    UNCERTAIN = "UNCERTAIN"


# ---- allowed areas and area alerts (revision 0019, Phase 16, docs/visitor-journey-design.md §9) --------


class ZoneAccess(StrEnum):
    """Who may be in a zone (B16-1): COMMON every visitor (reception, lobby, lifts: never an alert);
    STANDARD a visitor whose allowed areas name its floor or the zone; RESTRICTED only a visitor whose
    allowed zones name it (a server room, a board room)."""

    COMMON = "COMMON"
    STANDARD = "STANDARD"
    RESTRICTED = "RESTRICTED"


class TrackingAlertType(StrEnum):
    UNAUTHORIZED_AREA = "UNAUTHORIZED_AREA"  # a STANDARD zone outside the visit's (set) areas
    RESTRICTED_AREA = "RESTRICTED_AREA"  # a RESTRICTED zone the visit's zones do not name


class TrackingAlertStatus(StrEnum):
    OPEN = "OPEN"
    ACKNOWLEDGED = "ACKNOWLEDGED"
    RESOLVED = "RESOLVED"


class TrackingAlertResolution(StrEnum):
    RETURNED = "RETURNED"  # the journey's confirmed location is allowed again
    AREAS_CHANGED = "AREAS_CHANGED"  # the visit's allowed areas now allow it
    CHECKED_OUT = "CHECKED_OUT"  # the visitor left
    MANUAL = "MANUAL"  # a receptionist or an administrator
