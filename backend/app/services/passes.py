"""Visitor passes (contract §6): issuing, rotating and revoking, and classifying scanned input.

* A pass token is `secrets.token_urlsafe(32)`; only its SHA-256 is stored. The pass URL
  (`{QR_BASE_URL}/pass?c=<slug>#<token>`: the company's slug in the query, the token alone in the
  fragment, B12-14) is returned to the caller exactly once (`IssuedPass`) and goes into the invitation
  e-mail; it is never logged, stored or retrievable later.
* At most one pass of a visit is active (`uq_passes_active_visit`); every change happens under the
  visit's row lock (§3.2-4), revocation before issue.
* Scanner input: the scan endpoint and QR check-in/check-out accept whatever the scanner or the paste
  field delivered (`schemas.common.ScannerInput`: a size cap only). A token in the shared grammar is
  looked up by hash within the caller's company; anything else (malformed input, an unknown hash,
  another company's pass) is §6 row 1, answered 404 PASS_INVALID and audited as
  PASS_SCANNED{outcome: INVALID} with no entity and nothing from the input.
"""

from dataclasses import dataclass, field
from datetime import datetime
from uuid import UUID

from sqlalchemy.orm import Session

from app.core.config import Settings
from app.core.errors import PassInvalid
from app.core.request_context import RequestContext
from app.models import Company, PassRevokeReason, Visit, VisitorPass
from app.repositories.passes import PassRepository
from app.repositories.visits import VisitRepository
from app.security.tokens import build_pass_url, extract_pass_token, generate_token, hash_token
from app.services import audit
from app.services.audit import AuditAction, AuditEntity


def invalid_pass() -> PassInvalid:
    """The §6 row-1 error; `PassInvalid` audits PASS_SCANNED{outcome: INVALID} for the scanning user."""
    return PassInvalid()


def token_from_scanner_input(raw: str) -> str:
    """The pass token in scanner/paste input, or `invalid_pass()` for anything else (empty, control
    characters, over-long, wrong shape)."""
    token = extract_pass_token(raw)
    if token is None:
        raise invalid_pass()
    return token


@dataclass(frozen=True, slots=True)
class IssuedPass:
    pass_id: UUID
    token: str = field(repr=False)
    url: str = field(repr=False)


@dataclass(frozen=True, slots=True)
class PresentedPass:
    """A scanned pass of the caller's company and its visit."""

    visitor_pass: VisitorPass
    visit: Visit


class PassService:
    def __init__(self, db: Session, *, settings: Settings) -> None:
        self.db = db
        self.settings = settings
        self.passes = PassRepository(db)
        self.visits = VisitRepository(db)

    def issue(
        self,
        visit: Visit,
        *,
        company: Company,
        actor_id: UUID | None,
        context: RequestContext,
        now: datetime,
    ) -> IssuedPass:
        """A new active pass for `visit` (whose previous pass, if any, must already be revoked). `company`
        is the visit's: its slug goes into the pass link (B12-14)."""
        if company.id != visit.company_id:
            raise ValueError("a pass is issued for a visit of the given company")
        token = generate_token()
        visitor_pass = self.passes.add(
            VisitorPass(
                company_id=visit.company_id,
                visit_id=visit.id,
                token_hash=hash_token(token),
                created_by_id=actor_id,
                created_at=now,
            )
        )
        self._audit(AuditAction.PASS_ISSUED, visitor_pass, actor_id, context, {"visit_id": visit.id})
        return IssuedPass(
            pass_id=visitor_pass.id,
            token=token,
            url=build_pass_url(self.settings.pass_url_base, token, company.slug),
        )

    def revoke_active(
        self,
        visit: Visit,
        *,
        reason: PassRevokeReason,
        actor_id: UUID | None,
        context: RequestContext,
        now: datetime,
    ) -> VisitorPass | None:
        visitor_pass = self.passes.active_for_visit(visit.company_id, visit.id)
        if visitor_pass is None:
            return None
        visitor_pass.revoked_at = now
        visitor_pass.revoke_reason = reason.value
        self.db.flush()  # before a replacement is inserted (one active pass per visit)
        self._audit(
            AuditAction.PASS_REVOKED,
            visitor_pass,
            actor_id,
            context,
            {"visit_id": visit.id, "reason": reason},
        )
        return visitor_pass

    def replace(
        self,
        visit: Visit,
        *,
        company: Company,
        reason: PassRevokeReason,
        actor_id: UUID | None,
        context: RequestContext,
        now: datetime,
    ) -> IssuedPass:
        """Revoke the active pass with `reason` (ROTATED for a resend, VISITOR_EMAIL_CHANGED for D-19)
        and issue a new one."""
        self.revoke_active(visit, reason=reason, actor_id=actor_id, context=context, now=now)
        return self.issue(visit, company=company, actor_id=actor_id, context=context, now=now)

    def presented(self, company_id: UUID, raw_input: str) -> PresentedPass:
        """Resolve scanner input to a pass of `company_id` and its visit, or raise `invalid_pass()`."""
        token = token_from_scanner_input(raw_input)
        visitor_pass = self.passes.find_by_hash(company_id, hash_token(token))
        if visitor_pass is None:
            raise invalid_pass()
        visit = self.visits.get(company_id, visitor_pass.visit_id)
        if visit is None:  # impossible with the composite foreign key; answered like an unknown pass
            raise invalid_pass()
        return PresentedPass(visitor_pass=visitor_pass, visit=visit)

    def _audit(
        self,
        action: AuditAction,
        visitor_pass: VisitorPass,
        actor_id: UUID | None,
        context: RequestContext,
        metadata: dict[str, object],
    ) -> None:
        audit.record(
            self.db,
            action=action,
            context=context,
            company_id=visitor_pass.company_id,
            actor_user_id=actor_id,
            entity_type=AuditEntity.PASS,
            entity_id=visitor_pass.id,
            metadata=metadata,
        )
