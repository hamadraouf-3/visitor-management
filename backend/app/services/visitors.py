"""Visitors (contract §8 /visitors, §7.5, D-05, D-06, D-17, D-19).

Scope: SYSTEM_ADMIN, RECEPTIONIST and MANAGEMENT read every visitor of the company; an EMPLOYEE-only
caller reads the visitors they created or that are linked to a visit they own, and sees only their own
visits in a visitor's history and stats. A visitor outside the caller's scope answers 404 (path) or a
422 field error (body), never "exists but forbidden". A link made by reusing a visitor outside the
creator's scope (inline details matched by e-mail) gives no scope (`visits.visitor_link_in_scope`,
B24-15).

Edit rule: SYSTEM_ADMIN and RECEPTIONIST may edit any visitor; an EMPLOYEE only one in their scope that
has no visit owned by somebody else (MANAGEMENT may not edit). Editing refreshes the name snapshots of
the visitor's SCHEDULED visits (D-17). Changing the e-mail address revokes the active passes of the
visitor's SCHEDULED visits (VISITOR_EMAIL_CHANGED) and sends each a new invitation with a new pass to the
new address (D-19); clearing it only revokes them. Either way a visit whose calendar invitation went to
the old address is taken out of that calendar (B14-17). The re-sends count against the editor's daily
invitation budget, so a visitor with more SCHEDULED visits than that budget holds cannot be given a new
address until some are cancelled (422 on `email`, SEC-44); the withdrawals count against it too, while
it has room, and never hold the change up.

Visitors are deduplicated by e-mail within the company (`INSERT … ON CONFLICT DO NOTHING`, D-05), and a
visitor is reused that way only under its own name (B57-70). Reusing a visitor fills its empty fields
only for a caller the edit rule allows (B24-76).
"""

from collections import defaultdict
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime
from uuid import UUID

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core import time as app_time
from app.core.errors import Forbidden, SecurityEvent, ServiceBusy, ValidationFailed, VisitorExists
from app.core.field_errors import FieldCode, FieldProblem
from app.core.policy import INLINE_VISIT_LIST_CAP
from app.core.request_context import RequestContext
from app.core.search import (
    ascii_digits,
    name_sort_key,
    normalise_search_text,
    phone_query_digits,
    visitor_search_text,
)
from app.core.time import company_day_bounds, local_date
from app.db.errors import unique_violation_constraint
from app.email.dispatcher import ADDRESS_CHANGED_ERROR
from app.email.service import DeliveryJob, mailbox_key
from app.models import Company, PassRevokeReason, Visit, Visitor
from app.repositories.email_messages import EmailMessageRepository
from app.repositories.locking import RowLock
from app.repositories.visitors import EMAIL_CONSTRAINT, VisitorRepository
from app.repositories.visits import VisitRepository
from app.schemas.common import Paginated
from app.schemas.visitors import Visitor as VisitorOut
from app.schemas.visitors import (
    VisitorCreate,
    VisitorPermissions,
    VisitorSearchItem,
    VisitorStats,
    VisitorUpdate,
)
from app.schemas.visits import Visit as VisitOut
from app.schemas.visits import VisitorInput, VisitorSourceRequest
from app.security.permissions import Capability, has_capability
from app.security.sessions import AuthContext
from app.services import audit
from app.services.audit import AuditAction, AuditEntity
from app.services.authorization import lock_company_for_change
from app.services.email_quota import InvitationBatchTooLarge, QuotaUnit
from app.services.environment import ServiceEnvironment
from app.services.no_shows import mark_if_expired, mark_no_shows_committed
from app.services.results import Mutation
from app.services.scoping import FieldErrors, require_found, visit_read_owner, visitor_read_owner
from app.services.visit_lifecycle import VisitLifecycle, begin_visit_change
from app.services.visit_views import Viewer, VisitViewBuilder

type VisitorDetails = VisitorInput | VisitorCreate


def too_many_reinvitations(count: int, limit: int) -> FieldProblem:
    """Why an address change of a visitor with more SCHEDULED visits than the daily invitation budget is
    refused (SEC-44): every such visit gets a new invitation (D-19), and no wait makes room for them."""
    return FieldProblem(
        FieldCode.TOO_MANY_REINVITATIONS,
        f"This visitor has {count} scheduled visits. A new email address sends each of them a new "
        f"invitation, and at most {limit} invitations can be sent per user in 24 hours: cancel some of "
        "these visits first. Clearing the email address withdraws all their passes at once.",
        {"count": count, "limit": limit},
    )


# Inline details are matched to a visitor by address and that row is then locked. If a concurrent
# address change moved the visitor away while this request waited for the lock, the match starts over.
EMAIL_MATCH_ATTEMPTS = 3


@dataclass(frozen=True, slots=True)
class DerivedFields:
    """Columns the service derives from what a visitor's record says (contract §4, and the list order:
    `name_sort`)."""

    phone_digits: str | None
    search_text: str
    name_sort: str

    @classmethod
    def of(
        cls, full_name: str, email: str | None, phone: str | None, company_name: str | None
    ) -> DerivedFields:
        return cls(
            phone_digits=ascii_digits(phone),
            search_text=visitor_search_text(full_name, email, company_name),
            name_sort=name_sort_key(full_name),
        )

    @classmethod
    def of_visitor(cls, visitor: Visitor) -> DerivedFields:
        return cls.of(visitor.full_name, visitor.email, visitor.phone, visitor.company_name)

    def apply(self, visitor: Visitor) -> None:
        visitor.phone_digits = self.phone_digits
        visitor.search_text = self.search_text
        visitor.name_sort = self.name_sort


def _reveals_existing_visitor(auth: AuthContext) -> bool:
    """§7.5: a 409 VISITOR_EXISTS names the existing visitor only for callers who can read every visitor;
    EMPLOYEE-only callers learn nothing about records outside their scope."""
    return has_capability(auth.roles, Capability.READ_ALL_VISITORS)


def visitor_exists(auth: AuthContext, existing: Visitor | None) -> VisitorExists:
    if existing is not None and _reveals_existing_visitor(auth):
        return VisitorExists(details={"visitor_id": str(existing.id)})
    return VisitorExists()


REGISTERED_UNDER_ANOTHER_NAME = (
    "A visitor with this email address is already registered under a different name. Check the "
    "visitor's name, or ask reception to check the visitor's details."
)


def registered_visitor_message(visitor: Visitor) -> str:
    return (
        f"This email address belongs to the registered visitor “{visitor.full_name}”. "
        "Select that visitor, or correct the email."
    )


def same_person_name(typed: str, stored: str) -> bool:
    """Whether a typed name is the stored one, folded like search text (case, accents, Arabic letter
    variants, spacing: `core.search.name_sort_key`)."""
    return name_sort_key(typed) == name_sort_key(stored)


def registered_under_another_name(auth: AuthContext, visitor: Visitor) -> VisitorExists:
    """Inline details whose address matches a visitor whose name they do not have: the visit is not linked
    and nothing is filled in (B57-01, B57-70). Linking would put the visit, and with it a check-in, an
    invitation to the stored address and filled-in details, on another person's record. Callers who read
    every visitor are told whose address it is (`details.visitor_id`, B24-14), so they can choose that
    visitor; EMPLOYEE-only callers learn nothing (§7.5). Audited: repeated attempts by an EMPLOYEE-only
    caller are how the remaining whole-name oracle of an out-of-scope visitor would be probed."""
    events = [
        SecurityEvent(
            action=AuditAction.VISITOR_LINK_REFUSED,
            entity_type=AuditEntity.VISITOR,
            entity_id=visitor.id,
            metadata={"reason": "name_mismatch"},
        )
    ]
    if _reveals_existing_visitor(auth):
        return VisitorExists(
            registered_visitor_message(visitor),
            details={"visitor_id": str(visitor.id)},
            security_events=events,
        )
    return VisitorExists(REGISTERED_UNDER_ANOTHER_NAME, security_events=events)


def editable_visitors(db: Session, auth: AuthContext, visitor_ids: Sequence[UUID]) -> set[UUID]:
    """Which of `visitor_ids` the caller may edit (contract §7.5 edit rule, B24-13): every one with
    EDIT_ANY_VISITOR; with EDIT_VISITOR only those in the caller's own scope as an owner (created by
    them, or linked in scope to a visit they own) that have no visit whose host and creator are both
    somebody else. Reading every visitor (MANAGEMENT + EMPLOYEE) does not widen this."""
    roles = auth.roles
    if has_capability(roles, Capability.EDIT_ANY_VISITOR):
        return set(visitor_ids)
    if not has_capability(roles, Capability.EDIT_VISITOR):
        return set()
    company_id, me = auth.company_id, auth.user_id
    owned = VisitorRepository(db).ids_in_scope(company_id, visitor_ids, owner_id=me)
    foreign = VisitRepository(db).visitors_with_visits_not_owned_by(company_id, visitor_ids, me)
    return owned - foreign


def lock_scheduled_visits(db: Session, visitor: Visitor) -> tuple[list[Visit], datetime]:
    """The visitor's SCHEDULED visits locked in id order (`repositories.locking`), without those whose
    window has ended: they become NO_SHOW under the lock instead. Also returns the instant the locks
    were held from."""
    locked = VisitRepository(db).lock_scheduled_of_visitor(visitor.company_id, visitor.id)
    now = app_time.now()
    return [visit for visit in locked if not mark_if_expired(db, visit, now=now)], now


def refresh_visitor_snapshots(visits: Sequence[Visit], visitor: Visitor) -> None:
    """D-17 for the visitor's name and company on locked SCHEDULED visits. A visit linked by reuse outside
    its creator's scope keeps the details as typed (B24-15): copying the stored ones in would reveal
    them to the visit's owners."""
    for visit in visits:
        if visit.visitor_link_in_scope:
            visit.visitor_name = visitor.full_name
            visit.visitor_company_name = visitor.company_name


def _audit_visitor(
    db: Session,
    auth: AuthContext,
    action: AuditAction,
    visitor: Visitor,
    context: RequestContext,
    metadata: dict[str, object],
) -> None:
    audit.record(
        db,
        action=action,
        context=context,
        company_id=auth.company_id,
        actor_user_id=auth.user_id,
        entity_type=AuditEntity.VISITOR,
        entity_id=visitor.id,
        metadata=metadata,
    )


class VisitorWriter:
    """Creates visitor rows: a plain insert without an e-mail, otherwise the D-05 conditional insert."""

    def __init__(self, db: Session) -> None:
        self.db = db
        self.visitors = VisitorRepository(db)

    def add(self, auth: AuthContext, data: VisitorDetails, *, now: datetime) -> Visitor:
        derived = DerivedFields.of(data.full_name, data.email, data.phone, data.company_name)
        return self.visitors.add(
            Visitor(
                company_id=auth.company_id,
                full_name=data.full_name,
                email=data.email,
                phone=data.phone,
                phone_digits=derived.phone_digits,
                company_name=data.company_name,
                search_text=derived.search_text,
                name_sort=derived.name_sort,
                created_by_id=auth.user_id,
                owned_by_creator=visitor_read_owner(auth) is not None,
                created_at=now,
                updated_at=now,
            )
        )

    def add_unless_email_exists(
        self, auth: AuthContext, data: VisitorDetails, email: str, *, now: datetime
    ) -> Visitor | None:
        derived = DerivedFields.of(data.full_name, email, data.phone, data.company_name)
        return self.visitors.insert_unless_email_exists(
            auth.company_id,
            full_name=data.full_name,
            email=email,
            phone=data.phone,
            phone_digits=derived.phone_digits,
            company_name=data.company_name,
            search_text=derived.search_text,
            name_sort=derived.name_sort,
            created_by_id=auth.user_id,
            owned_by_creator=visitor_read_owner(auth) is not None,
            now=now,
        )


# ---- responses ----------------------------------------------------------------------------------


class VisitorViewBuilder:
    """Builds `Visitor` / `VisitorSearchItem` for one caller with a fixed number of queries per page."""

    def __init__(self, db: Session, auth: AuthContext, *, now: datetime) -> None:
        self.db = db
        self.auth = auth
        self.now = now
        self.visits = VisitRepository(db)

    def build(self, visitors: Sequence[Visitor]) -> list[VisitorOut]:
        ids = [visitor.id for visitor in visitors]
        stats = self.visits.visitor_stats(self.auth.company_id, ids, owner_id=visit_read_owner(self.auth))
        editable = editable_visitors(self.db, self.auth, ids)
        views = []
        for visitor in visitors:
            total, last_check_in = stats.get(visitor.id, (0, None))
            views.append(
                VisitorOut(
                    id=visitor.id,
                    full_name=visitor.full_name,
                    email=visitor.email,
                    phone=visitor.phone,
                    company_name=visitor.company_name,
                    created_at=visitor.created_at,
                    updated_at=visitor.updated_at,
                    stats=VisitorStats(total_visits=total, last_visit_at=last_check_in),
                    permissions=VisitorPermissions(can_edit=visitor.id in editable),
                )
            )
        return views

    def build_search_items(self, visitors: Sequence[Visitor]) -> list[VisitorSearchItem]:
        """`Visitor` plus the visitor's actionable visits in scope: SCHEDULED for today or with a pass that
        works today (SEC-R2), and checked in."""
        viewer = Viewer.of(self.auth)
        day_start, day_end = company_day_bounds(local_date(self.now, viewer.timezone), viewer.timezone)
        visits = self.visits.actionable_for_visitors(
            self.auth.company_id,
            [visitor.id for visitor in visitors],
            owner_id=visit_read_owner(self.auth),
            day_start=day_start,
            day_end=day_end,
            now=self.now,
            limit=INLINE_VISIT_LIST_CAP,
        )
        views = VisitViewBuilder(self.db, viewer, now=self.now).build(visits)
        by_visitor: dict[UUID, list[VisitOut]] = defaultdict(list)
        for visit, view in zip(visits, views, strict=True):
            by_visitor[visit.visitor_id].append(view)
        return [
            VisitorSearchItem(**base.model_dump(), today_visits=by_visitor.get(base.id, []))
            for base in self.build(visitors)
        ]


# ---- the visitor of a new visit or walk-in ------------------------------------------------------


@dataclass(frozen=True, slots=True)
class VisitorChoice:
    """The visitor a visit request names, checked but not yet written."""

    existing: Visitor | None  # chosen by `visitor_id`, within the caller's scope
    inline: VisitorInput | None

    @property
    def email(self) -> str | None:
        if self.existing is not None:
            return self.existing.email
        return self.inline.email if self.inline is not None else None


@dataclass(frozen=True, slots=True)
class ResolvedVisitor:
    visitor: Visitor  # locked: its address cannot change (D-19) until the visit is committed
    reused: bool  # inline details matched an existing visitor by e-mail
    in_scope: bool  # the link gives the caller read scope (`Visit.visitor_link_in_scope`)
    snapshot_name: str
    snapshot_company_name: str | None
    created: bool = False  # the visitor was registered by this request (no record existed)


def _fillable_fields(visitor: Visitor, inline: VisitorInput) -> dict[str, str]:
    """The stored visitor's empty fields that the inline details would fill in (D-05: reuse never
    overwrites), in a fixed order."""
    fills: dict[str, str] = {}
    if visitor.phone is None and inline.phone is not None:
        fills["phone"] = inline.phone
    if visitor.company_name is None and inline.company_name is not None:
        fills["company_name"] = inline.company_name
    return fills


class VisitorResolver:
    """Turns the visitor part of `VisitCreate` / `WalkInCreate` into a visitor row (contract §7.5, D-05).

    * `visitor_id` must be in the caller's visitor scope, otherwise a 422 field error (no oracle).
    * Inline details with an e-mail reuse the company's visitor with that address, but only when the
      entered name is the stored one (folded like search text); otherwise 409 VISITOR_EXISTS and nothing
      is linked or written, whoever the caller is (B57-01, B57-70). Reuse never overwrites: only empty
      fields are filled, and only when the caller may edit that visitor (the edit rule, which is
      stricter than reading it: B24-76). A visitor the caller reads but may not edit is linked with its
      stored details. For a visitor outside the read scope nothing stored is filled in or revealed: the
      visit's snapshots take the details as entered, the response says only `reused = true`, and the
      link gives the caller no access to the stored record (`in_scope` false, B24-15).
    * Inline details without an e-mail always create a new visitor.

    The visitor row ends up locked (`FOR KEY SHARE`, or `FOR UPDATE` when fields are filled in), so a
    concurrent address change (D-19) either waits for the new visit and then re-invites it, or has
    committed before and the visit is invited at the new address.
    """

    def __init__(self, db: Session) -> None:
        self.db = db
        self.visitors = VisitorRepository(db)
        self.writer = VisitorWriter(db)

    def choose(self, auth: AuthContext, request: VisitorSourceRequest, errors: FieldErrors) -> VisitorChoice:
        if request.visitor_id is not None:
            existing = errors.require(
                self.visitors.get(
                    auth.company_id,
                    request.visitor_id,
                    owner_id=visitor_read_owner(auth),
                    lock=RowLock.KEY_SHARE,
                ),
                "visitor_id",
            )
            return VisitorChoice(existing=existing, inline=None)
        return VisitorChoice(existing=None, inline=request.visitor)

    def resolve(
        self, auth: AuthContext, choice: VisitorChoice, *, context: RequestContext, now: datetime
    ) -> ResolvedVisitor:
        if choice.existing is not None:
            visitor = choice.existing
            return ResolvedVisitor(visitor, False, True, visitor.full_name, visitor.company_name)
        inline = choice.inline
        if inline is None:  # excluded by VisitorSourceRequest
            raise ValueError("a visitor choice needs an existing visitor or inline details")
        if inline.email is None:
            created = self.writer.add(auth, inline, now=now)
            self._audit_created(auth, created, context)
            return ResolvedVisitor(
                created, False, True, created.full_name, created.company_name, created=True
            )

        for _ in range(EMAIL_MATCH_ATTEMPTS):
            inserted = self.writer.add_unless_email_exists(auth, inline, inline.email, now=now)
            if inserted is not None:
                self._audit_created(auth, inserted, context)
                return ResolvedVisitor(
                    inserted, False, True, inserted.full_name, inserted.company_name, created=True
                )
            matched = self._match(auth, inline, inline.email, context=context)
            if matched is not None:
                return matched
        raise ServiceBusy()

    def _match(
        self, auth: AuthContext, inline: VisitorInput, email: str, *, context: RequestContext
    ) -> ResolvedVisitor | None:
        """Reuse the company's visitor with `email`, locked; None when no visitor has the address any more
        (a concurrent change moved it while this request waited for the row).

        The typed name must be the stored one, for every caller: an address alone does not make two
        people one (B57-70). It is compared on the locked row, before anything is written, so a refused
        request has filled nothing in.

        Linking needs read scope; filling empty fields is an edit and needs the edit rule (§7.5): a
        filled-in company name also reaches the snapshots of the visitor's SCHEDULED visits (D-17). Only
        a fill takes the exclusive lock (concurrent fills then see each other's values), and the rule is
        checked again once it is held: a visit of another owner committed while this request waited
        makes the visitor no longer the caller's to edit."""
        candidate = self.visitors.get_by_email(auth.company_id, email)
        if candidate is None:
            return None
        owner = visitor_read_owner(auth)
        in_scope = owner is None or bool(
            self.visitors.ids_in_scope(auth.company_id, [candidate.id], owner_id=owner)
        )
        fill = in_scope and bool(_fillable_fields(candidate, inline)) and self._editable(auth, candidate)
        lock = RowLock.UPDATE if fill else RowLock.KEY_SHARE
        locked = self.visitors.get_by_email(auth.company_id, email, lock=lock)
        if locked is None or locked.id != candidate.id:
            return None
        if not same_person_name(inline.full_name, locked.full_name):
            raise registered_under_another_name(auth, locked)
        if not in_scope:
            return ResolvedVisitor(locked, True, False, inline.full_name, inline.company_name)
        if fill and self._editable(auth, locked):
            self._fill_empty_fields(auth, locked, inline, context=context)
        return ResolvedVisitor(locked, True, True, locked.full_name, locked.company_name)

    def _editable(self, auth: AuthContext, visitor: Visitor) -> bool:
        return visitor.id in editable_visitors(self.db, auth, [visitor.id])

    def _fill_empty_fields(
        self, auth: AuthContext, visitor: Visitor, inline: VisitorInput, *, context: RequestContext
    ) -> None:
        fills = _fillable_fields(visitor, inline)
        if not fills:
            return
        for name, value in fills.items():
            setattr(visitor, name, value)
        DerivedFields.of_visitor(visitor).apply(visitor)
        self.db.flush()
        if "company_name" in fills:
            visits, _ = lock_scheduled_visits(self.db, visitor)
            refresh_visitor_snapshots(visits, visitor)
        _audit_visitor(
            self.db,
            auth,
            AuditAction.VISITOR_UPDATED,
            visitor,
            context,
            {"changed_fields": list(fills), "source": "visit_inline"},
        )

    def _audit_created(self, auth: AuthContext, visitor: Visitor, context: RequestContext) -> None:
        _audit_visitor(
            self.db,
            auth,
            AuditAction.VISITOR_CREATED,
            visitor,
            context,
            {"source": "visit_inline", "has_email": visitor.email is not None},
        )


# ---- service ------------------------------------------------------------------------------------


class VisitorsService:
    def __init__(self, db: Session, env: ServiceEnvironment) -> None:
        self.db = db
        self.env = env
        self.visitors = VisitorRepository(db)
        self.visits = VisitRepository(db)
        self.writer = VisitorWriter(db)
        self.quota = env.email_quota()

    # ---- reads ----------------------------------------------------------------------------------

    def search(
        self, auth: AuthContext, *, q: str | None, page: int, page_size: int
    ) -> Paginated[VisitorSearchItem]:
        """Name, e-mail and company (normalised, §4) or the phone's last nine digits."""
        now = app_time.now()
        mark_no_shows_committed(self.db, auth.company_id, now=now)  # today's visits show their status
        result = self.visitors.search(
            auth.company_id,
            owner_id=visitor_read_owner(auth),
            text=normalise_search_text(q) if q else None,
            phone_digits=phone_query_digits(q) if q else None,
            page=page,
            page_size=page_size,
        )
        return Paginated[VisitorSearchItem](
            items=VisitorViewBuilder(self.db, auth, now=now).build_search_items(result.items),
            page=result.page,
            page_size=result.page_size,
            total=result.total,
        )

    def get(self, auth: AuthContext, visitor_id: UUID) -> VisitorOut:
        visitor = self._readable(auth, visitor_id)
        return VisitorViewBuilder(self.db, auth, now=app_time.now()).build([visitor])[0]

    def history(
        self, auth: AuthContext, visitor_id: UUID, *, page: int, page_size: int
    ) -> Paginated[VisitOut]:
        """The visitor's visits in the caller's scope, newest first."""
        self._readable(auth, visitor_id)
        now = app_time.now()
        mark_no_shows_committed(self.db, auth.company_id, now=now)
        result = self.visits.list_for_visitor(
            auth.company_id, visitor_id, owner_id=visit_read_owner(auth), page=page, page_size=page_size
        )
        return Paginated[VisitOut](
            items=VisitViewBuilder(self.db, Viewer.of(auth), now=now).build(result.items),
            page=result.page,
            page_size=result.page_size,
            total=result.total,
        )

    # ---- writes ---------------------------------------------------------------------------------

    def create(self, auth: AuthContext, data: VisitorCreate, context: RequestContext) -> VisitorOut:
        # Like every visitor change (`begin_visit_change`): the caller is re-checked once the company row
        # is held, so a deactivated user's in-flight request registers nobody (SEC-07, SEC-31).
        lock_company_for_change(self.db, auth, lock=RowLock.KEY_SHARE)
        now = app_time.now()
        if data.email is None:
            visitor = self.writer.add(auth, data, now=now)
        else:
            inserted = self.writer.add_unless_email_exists(auth, data, data.email, now=now)
            if inserted is None:
                raise visitor_exists(auth, self.visitors.get_by_email(auth.company_id, data.email))
            visitor = inserted
        _audit_visitor(
            self.db,
            auth,
            AuditAction.VISITOR_CREATED,
            visitor,
            context,
            {"source": "visitors_api", "has_email": visitor.email is not None},
        )
        payload = VisitorViewBuilder(self.db, auth, now=now).build([visitor])[0]
        self.db.commit()
        return payload

    def update(
        self, auth: AuthContext, visitor_id: UUID, data: VisitorUpdate, context: RequestContext
    ) -> Mutation[VisitorOut]:
        """Locks: company (shared), the visitor, then its SCHEDULED visits in id order
        (`repositories.locking`)."""
        company = begin_visit_change(self.db, auth)
        with self.quota.unit() as quota:
            visitor = require_found(
                self.visitors.get(
                    auth.company_id, visitor_id, owner_id=visitor_read_owner(auth), lock=RowLock.UPDATE
                )
            )
            views = VisitorViewBuilder(self.db, auth, now=app_time.now())
            if visitor.id not in editable_visitors(self.db, auth, [visitor.id]):
                raise Forbidden()

            supplied = data.model_fields_set
            changes: dict[str, str | None] = {}
            if data.full_name is not None and data.full_name != visitor.full_name:
                changes["full_name"] = data.full_name
            for name in ("email", "phone", "company_name"):
                if name in supplied and getattr(data, name) != getattr(visitor, name):
                    changes[name] = getattr(data, name)
            if not changes:
                return Mutation(views.build([visitor])[0])

            changed = list(changes)
            old_email = visitor.email
            try:
                # The changes are made inside the savepoint: `begin_nested` flushes pending changes first.
                with self.db.begin_nested():
                    for name, value in changes.items():
                        setattr(visitor, name, value)
                    DerivedFields.of_visitor(visitor).apply(visitor)
                    self.db.flush()
            except IntegrityError as exc:
                if unique_violation_constraint(exc) != EMAIL_CONSTRAINT or data.email is None:
                    raise
                with self.db.no_autoflush:
                    existing = self.visitors.get_by_email(auth.company_id, data.email)
                raise visitor_exists(auth, existing) from None
            _audit_visitor(
                self.db, auth, AuditAction.VISITOR_UPDATED, visitor, context, {"changed_fields": changed}
            )

            jobs: tuple[DeliveryJob, ...] = ()
            if {"full_name", "company_name", "email"} & set(changed):
                visits, now = lock_scheduled_visits(self.db, visitor)
                if {"full_name", "company_name"} & set(changed):
                    refresh_visitor_snapshots(visits, visitor)
                if "email" in changed:
                    jobs = self._reissue_passes(
                        auth,
                        visitor,
                        visits,
                        old_email=old_email,
                        company=company,
                        quota=quota,
                        context=context,
                        now=now,
                    )
            payload = views.build([visitor])[0]
            self.db.commit()
        return Mutation(payload, jobs)

    # ---- helpers --------------------------------------------------------------------------------

    def _readable(self, auth: AuthContext, visitor_id: UUID) -> Visitor:
        return require_found(
            self.visitors.get(auth.company_id, visitor_id, owner_id=visitor_read_owner(auth))
        )

    def _reissue_passes(
        self,
        auth: AuthContext,
        visitor: Visitor,
        visits: Sequence[Visit],
        *,
        old_email: str | None,
        company: Company,
        quota: QuotaUnit,
        context: RequestContext,
        now: datetime,
    ) -> tuple[DeliveryJob, ...]:
        """D-19: the passes of the visitor's SCHEDULED visits (`visits`, locked) may have reached the wrong
        person, so they are revoked (VISITOR_EMAIL_CHANGED). A visit whose event the calendar of
        `old_email` holds is taken out of that calendar, one version newer (B14-17), unless the new
        address is the same mailbox (B14-30); a REQUEST still waiting to go there is closed first (B14-29).
        With a new address each visit gets a new pass and an invitation to it, one version above the
        withdrawal, all of them reserved in the editor's invitation budget first: 429 INVITATION_LIMIT
        while the budget has no room for them yet, 422 on `email` when they are more than the budget can
        ever hold (SEC-44). The withdrawals count against it after them, while it has room: refusing one
        would keep the event at the old address, and the old address with it."""
        if not visits:
            return ()
        lifecycle = VisitLifecycle(self.db, self.env)
        reason = PassRevokeReason.VISITOR_EMAIL_CHANGED
        withdrawn = lifecycle.holders(visits, old_email)
        if old_email is not None:
            # A REQUEST still waiting to go to the old address would put the visit back in that calendar
            # after its withdrawal (B14-29).
            EmailMessageRepository(self.db).close_pending_requests(
                company.id, [visit.id for visit in visits], old_email, error=ADDRESS_CHANGED_ERROR, now=now
            )
        # Another spelling of the same mailbox (B14-21): its calendar keeps the visit, which the new
        # address's invitation updates (B14-30).
        same_mailbox = (
            old_email is not None
            and visitor.email is not None
            and mailbox_key(old_email) == mailbox_key(visitor.email)
        )
        if visitor.email is not None:
            try:
                quota.invitations(auth.user_id, count=len(visits))
            except InvitationBatchTooLarge as exc:
                # More than the budget can ever hold: a 429 "try again later" would never succeed (SEC-44).
                raise ValidationFailed({"email": too_many_reinvitations(exc.count, exc.limit)}) from None
        jobs: list[DeliveryJob] = []
        for visit in visits:
            withdraw_from = old_email if visit.id in withdrawn and not same_mailbox else None
            if withdraw_from is not None:
                jobs.append(lifecycle.withdraw_visitor_event(visit, company=company, address=withdraw_from))
                quota.withdrawal(auth.user_id, company.id)
            if visitor.email is None:
                lifecycle.passes.revoke_active(
                    visit, reason=reason, actor_id=auth.user_id, context=context, now=now
                )
                continue
            if withdraw_from is not None:
                # The new address's event is one version above the withdrawal's, so that a calendar that
                # receives both (one person's two addresses) keeps the visit, whatever their order (B14-30).
                visit.calendar_sequence += 1
            issued = lifecycle.passes.replace(
                visit, company=company, reason=reason, actor_id=auth.user_id, context=context, now=now
            )
            jobs += lifecycle.invite(
                visit,
                issued,
                company=company,
                recipient=visitor.email,
                actor_id=auth.user_id,
                context=context,
                quota=quota,
            )
        return tuple(jobs)
