"""The lifecycle of visits' tracking associations (Phase 15, B15-14, B15-15, B15-18).

An association ends, once, and never becomes active again:

* **check-out**: in the check-out's own transaction (`end_for_check_out`, called by the attendance
  service for every check-out: QR, MANUAL, CORRECTED and the bulk one), reason CHECKED_OUT, at the
  check-out time (never before the association's creation);
* **revoke**: a receptionist's or an administrator's explicit revoke (TRACKING_ASSOCIATION_REVOKED), the
  administrator switching tracking off, the platform owner disallowing it, or the company's deactivation
  (`end_all_of_company`), reason REVOKED;
* **expiry**: `expires_at` passed (`expire_due`), checked on every read and ingest, not by a job, and at
  check-out (an association already expired when the visitor leaves ends EXPIRED, not CHECKED_OUT,
  B15-35); it ends at `expires_at`: 10 minutes after its creation while PENDING, 12 hours after its
  activation once ACTIVE (B15-34);
* **enrollment failure**: the provider's ENROLLMENT_FAILED event, or an enroll request the provider did
  not take;
* **cancellation**: never today (a checked-in visit cannot be cancelled, `visit_rules`); the reason
  VISIT_CANCELLED is reserved.

Ending calls the provider's `revoke(ref)` **after** the caller's commit (`after_commit`): best effort, a
failure is counted in the company's health record (PROVIDER_REVOKE_FAILED) and logged without the ref; a
failure to count it is logged too and never turns the committed change into an error (B15-37).
"""

import logging
from collections import Counter
from datetime import datetime
from uuid import UUID

from sqlalchemy.orm import Session

from app.core.request_context import RequestContext
from app.models import TrackingAssociation, TrackingEndReason, Visit
from app.models.enums import TrackingAssociationStatus
from app.repositories.companies import CompanyRepository
from app.repositories.locking import RowLock
from app.repositories.tracking import AssociationRepository, TrackingHealthRepository
from app.services import audit
from app.services.audit import AuditAction, AuditEntity
from app.services.tracking_provider import TrackingProvider
from app.services.tracking_rules import ProviderOperation, provider_failure_reason

logger = logging.getLogger("app.tracking")


class EndTrigger:
    """What ended an association (`metadata.trigger` of its audit row)."""

    USER = "USER"
    CHECK_OUT = "CHECK_OUT"
    EXPIRY = "EXPIRY"
    PROVIDER = "PROVIDER"
    TRACKING_DISABLED = "TRACKING_DISABLED"
    TRACKING_DISALLOWED = "TRACKING_DISALLOWED"
    COMPANY_DEACTIVATED = "COMPANY_DEACTIVATED"


class TrackingLifecycle:
    """Ends associations in the caller's transaction and calls the provider after its commit."""

    def __init__(self, db: Session, provider: TrackingProvider) -> None:
        self.db = db
        self.provider = provider
        self.associations = AssociationRepository(db)
        self._revocations: list[tuple[UUID, str]] = []

    def end(
        self,
        association: TrackingAssociation,
        *,
        reason: TrackingEndReason,
        at: datetime,
        now: datetime,
        trigger: str,
        context: RequestContext,
        actor_id: UUID | None = None,
        action: AuditAction = AuditAction.TRACKING_ASSOCIATION_ENDED,
        extra: dict[str, object] | None = None,
    ) -> None:
        """End an open association (the caller holds its row lock) and audit it on its visit."""
        if association.status == TrackingAssociationStatus.ENDED:
            return
        association.status = TrackingAssociationStatus.ENDED.value
        association.ended_at = max(at, association.created_at)
        association.ended_reason = reason.value
        association.updated_at = now
        self.db.flush()
        audit.record(
            self.db,
            action=action,
            context=context,
            company_id=association.company_id,
            actor_user_id=actor_id,
            entity_type=AuditEntity.VISIT,
            entity_id=association.visit_id,
            metadata={
                "association_id": association.id,
                "reason": reason,
                "trigger": trigger,
                **(extra or {}),
            },
        )
        if reason is not TrackingEndReason.ENROLLMENT_FAILED:
            # The provider took nothing it could forget when its enrollment failed.
            self._revocations.append((association.company_id, association.ref))

    def end_for_check_out(
        self, visit: Visit, *, actor_id: UUID, context: RequestContext, now: datetime
    ) -> None:
        """The check-out's part (B15-14): its visit is locked and now CHECKED_OUT."""
        association = self.associations.open_for_visit(visit.company_id, visit.id, lock=RowLock.UPDATE)
        if association is None:
            return
        left_at = visit.check_out_at or now
        if association.expires_at <= left_at:
            # Expired before the visitor left and not swept yet (nothing read the journey since): it ended
            # at its expiry, not at the check-out (B15-35).
            self.end(
                association,
                reason=TrackingEndReason.EXPIRED,
                at=association.expires_at,
                now=now,
                trigger=EndTrigger.EXPIRY,
                context=context,
            )
            return
        self.end(
            association,
            reason=TrackingEndReason.CHECKED_OUT,
            at=left_at,
            now=now,
            trigger=EndTrigger.CHECK_OUT,
            context=context,
            actor_id=actor_id,
        )

    def expire_due(self, company_id: UUID, *, now: datetime, context: RequestContext) -> int:
        """End the company's open associations whose expiry has passed (at their expiry). A read without
        any writes nothing and takes no lock."""
        if not self.associations.has_expired(company_id, now=now):
            return 0
        # The company row first, like every writer (B15-29); a no-op where the caller holds it already.
        CompanyRepository(self.db).get(company_id, lock=RowLock.KEY_SHARE)
        expired = self.associations.lock_expired(company_id, now=now)
        for association in expired:
            self.end(
                association,
                reason=TrackingEndReason.EXPIRED,
                at=association.expires_at,
                now=now,
                trigger=EndTrigger.EXPIRY,
                context=context,
            )
        return len(expired)

    def end_all_of_company(
        self,
        company_id: UUID,
        *,
        trigger: str,
        now: datetime,
        context: RequestContext,
        actor_id: UUID | None = None,
        extra: dict[str, object] | None = None,
    ) -> int:
        """End every open association of the company (REVOKED). The caller holds the company row
        `FOR UPDATE`, so no enrollment starts meanwhile."""
        associations = self.associations.lock_open_of_company(company_id)
        for association in associations:
            self.end(
                association,
                reason=TrackingEndReason.REVOKED,
                at=now,
                now=now,
                trigger=trigger,
                context=context,
                actor_id=actor_id,
                extra=extra,
            )
        return len(associations)

    def after_commit(self, *, now: datetime) -> None:
        """Ask the provider to forget every association ended since the last call. Call it after the
        commit that ended them. Failures are counted per company and committed; nothing is raised."""
        pending, self._revocations = self._revocations, []
        failures: Counter[UUID] = Counter()
        for company_id, ref in pending:
            try:
                self.provider.revoke(company_id=company_id, ref=ref)
            except Exception as exc:
                # Never the ref, never the provider's message (it could quote it).
                logger.warning("tracking provider revoke failed", extra={"error": type(exc).__name__})
                failures[company_id] += 1
        if not failures:
            return
        try:
            health = TrackingHealthRepository(self.db)
            reason = provider_failure_reason(ProviderOperation.REVOKE)
            for company_id, count in failures.items():
                health.count(company_id, {reason: count}, now=now)
            self.db.commit()
        except Exception as exc:
            # The change the caller committed stands (a check-out, a switch-off): counting its provider
            # failures is bookkeeping and never turns it into an error (B15-37).
            self.db.rollback()
            logger.warning("counting a tracking provider failure failed", extra={"error": type(exc).__name__})
