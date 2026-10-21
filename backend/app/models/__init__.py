"""ORM models. Importing this package registers every table on `Base.metadata`."""

from app.models.audit_log import AuditLog
from app.models.brand import CompanyBrandAsset
from app.models.company import Company
from app.models.department import Department
from app.models.email_message import EmailMessage
from app.models.email_template import EmailTemplateOverride
from app.models.enums import (
    DEFAULT_LANGUAGE,
    EDITABLE_EMAIL_KINDS,
    BrandAssetKind,
    CheckInMethod,
    CheckOutMethod,
    EmailKind,
    EmailStatus,
    EventMethod,
    JourneyEventType,
    Language,
    ObservationMatch,
    PassRevokeReason,
    Role,
    TemplateField,
    TrackingAssociationStatus,
    TrackingEndReason,
    VisitStatus,
)
from app.models.platform import PlatformAdmin, PlatformAuditLog, PlatformSession
from app.models.tracking import (
    Building,
    CompanyTrackingSettings,
    Floor,
    TrackingAssociation,
    TrackingCamera,
    TrackingHealth,
    TrackingHealthCount,
    TrackingKey,
    VisitorJourneyEvent,
    Zone,
)
from app.models.user import PasswordResetToken, User, UserSession
from app.models.visit import Visit
from app.models.visitor import Visitor
from app.models.visitor_pass import VisitorPass

__all__ = [
    "DEFAULT_LANGUAGE",
    "EDITABLE_EMAIL_KINDS",
    "AuditLog",
    "BrandAssetKind",
    "Building",
    "CheckInMethod",
    "CheckOutMethod",
    "Company",
    "CompanyBrandAsset",
    "CompanyTrackingSettings",
    "Department",
    "EmailKind",
    "EmailMessage",
    "EmailStatus",
    "EmailTemplateOverride",
    "EventMethod",
    "Floor",
    "JourneyEventType",
    "Language",
    "ObservationMatch",
    "PassRevokeReason",
    "PasswordResetToken",
    "PlatformAdmin",
    "PlatformAuditLog",
    "PlatformSession",
    "Role",
    "TemplateField",
    "TrackingAssociation",
    "TrackingAssociationStatus",
    "TrackingCamera",
    "TrackingEndReason",
    "TrackingHealth",
    "TrackingHealthCount",
    "TrackingKey",
    "User",
    "UserSession",
    "Visit",
    "VisitStatus",
    "Visitor",
    "VisitorJourneyEvent",
    "VisitorPass",
    "Zone",
]
