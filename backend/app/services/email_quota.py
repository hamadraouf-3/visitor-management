"""Budgets for the e-mails sent because of what a user does (contract §7.3, B24-29, B24-70, B57-62).

* Invitations (a visit created with `send_invitation`, a resend, the re-sends after a visitor's address
  changed, D-19): INVITATION_DAILY_LIMIT per user and 24 hours; a resend also 3 per visit and hour.
  Beyond a budget the request is refused with 429 INVITATION_LIMIT before anything is written.
* Pass rotations without an e-mail (POST /visits/{id}/pass, B57-04) share a resend's per-visit budget:
  both replace the visit's pass, so at most 3 replacements per visit and hour, whichever way. They send
  nothing, so they do not count against the daily invitation budget; beyond the per-visit one the
  request is refused with 429 RATE_LIMITED.
* Reschedule notices (D-22): RESCHEDULE_NOTICE_DAILY_LIMIT per user and 24 hours and
  RATE_LIMIT_RESCHEDULE_NOTICES_PER_VISIT_HOUR per visit. Beyond a budget the change is still made and
  only the e-mail is left out.
* Host-arrival e-mails (a check-in by any method, a walk-in): HOST_ARRIVAL_DAILY_LIMIT per user who
  checks visitors in and 24 hours. They go to the company's own hosts, but carry text the visit's creator
  or the receptionist typed (visitor name, purpose); a walk-in, a check-out and the next walk-in of the
  same visitor would otherwise send one every three requests. Beyond the budget the check-in still
  succeeds and only the e-mail is left out.
* The host's e-mails of a scheduled visit (Phase 14, B14-15: a new visit, its new time, its
  cancellation): HOST_VISIT_NOTICE_DAILY_LIMIT per user whose action sends them and 24 hours, whoever the
  hosts are. A user who creates and cancels visits for themselves would otherwise send two a request.
  They are not in the reschedule budgets: a quick fourth correction of a time still moves the host's
  calendar. Beyond the budget the visit is still created, moved or cancelled; only the e-mail is left out.
* The calendar events (B14-15, B14-28): CALENDAR_EMAIL_COMPANY_DAILY_LIMIT per company and 24 hours, on top
  of the budgets above. Every company's e-mails leave through the one sending mailbox, whose provider caps
  a day's messages; this keeps one company from using up the others' day. It counts the e-mails that
  carry a visit's event, and what goes beyond it is the event:
  - an e-mail that is only the event (the visitor's calendar invitation, the host's notice of a new
    visit) is left out (`calendar_event`, `host_new_visit_notice`);
  - a notice that carries an event (of a new time, the visitor's or the host's) goes without it
    (`calendar_event`): the person is still told;
  - an event that takes the visit out of a calendar (a cancellation, the withdrawal from an address the
    visitor no longer has, D-19, B14-17, which also counts against the editor's daily invitations) is
    never left out (`calendar_removal`, `withdrawal`): a cancelled visit always leaves the visitor's
    calendar (the owner's rule, B14-16). Each follows an event that was counted, at most one per visit and
    address, so those bound them; they take a slot while there is one.
* The calendar invitation sent again on its own (a resend when only the calendar invitation failed,
  B14-31): one of the visit's hourly resends, of the user's daily invitations and of the company's
  calendar events, all or none (`calendar_resend`); refused with 429 INVITATION_LIMIT otherwise.

* The tracking alerts' e-mails (Phase 16, B16-15): TRACKING_ALERT_EMAILS_PER_COMPANY_DAY per company and 24
  hours, one per recipient of an opened or escalated alert. Beyond it the alert still opens (or escalates)
  and the e-mails that do not fit are left out; its audit row says which budget left them out. On top of
  it (B16-25), TRACKING_ALERT_NOTICES_PER_VISIT_HOUR e-mailed openings and escalations per visit and hour,
  whatever their number of recipients: the notice's slot is reserved with its first recipient's company
  slot, both or neither; beyond it nothing of that notice is queued.

Cancellation notices to visitors have no budget of their own: one goes out at most once per visit whose
invitation was requested (and counted), so the invitation budget bounds them.

Slots are reserved atomically, all of a request's slots or none, and count only when the unit of work
ends without an error, i.e. after the caller committed; a request that fails gives them back. A request
that needs more invitations than the daily budget can ever hold (the D-19 re-sends of a visitor with
more SCHEDULED visits than INVITATION_DAILY_LIMIT) is not a "try again later": `InvitationBatchTooLarge`
lets the caller answer with what to do instead (SEC-44).
"""

from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from uuid import UUID

from app.core.errors import InvitationLimit, RateLimited
from app.core.rate_limit import LimitKey, PolicyName, RateLimiter, RatePolicies, Reservation


class InvitationBatchTooLarge(Exception):
    """One request needs `count` invitations, more than the daily budget's `limit`: no wait can make room,
    so the caller must not answer 429 with a Retry-After."""

    def __init__(self, count: int, limit: int) -> None:
        super().__init__(f"{count} invitations exceed the daily budget of {limit}")
        self.count = count
        self.limit = limit


class QuotaUnit:
    """The slots one request has reserved; settled by `EmailQuota.unit`."""

    def __init__(self, limiter: RateLimiter, policies: RatePolicies) -> None:
        self._limiter = limiter
        self._policies = policies
        self._held: list[Reservation] = []

    def invitations(self, user_id: UUID, *, count: int = 1, resend_of: UUID | None = None) -> None:
        """Reserve `count` invitations of the user's daily budget (and, for a resend of a visit, one of
        that visit's hourly resends), or raise 429 INVITATION_LIMIT; `InvitationBatchTooLarge` when
        `count` exceeds the daily budget itself."""
        keys: list[LimitKey] = []
        if resend_of is not None:
            keys.append(LimitKey(self._policies.invitation_resends_per_visit, str(resend_of)))
        keys.append(LimitKey(self._policies.invitations_per_user_day, str(user_id), slots=count))
        reservation = self._reserve(keys)
        if reservation.denied_by is not None:
            if reservation.exceeds_limit:
                raise InvitationBatchTooLarge(count, reservation.denied_by.limit)
            raise InvitationLimit(retry_after=reservation.retry_after, policy=reservation.denied_by.name)

    def pass_rotation(self, visit_id: UUID) -> None:
        """Reserve one of the visit's hourly pass replacements (shared with resends), or raise 429
        RATE_LIMITED."""
        reservation = self._reserve([LimitKey(self._policies.invitation_resends_per_visit, str(visit_id))])
        if reservation.denied_by is not None:
            raise RateLimited(retry_after=reservation.retry_after, policy=reservation.denied_by.name)

    def reschedule_notice(self, user_id: UUID, visit_id: UUID) -> PolicyName | None:
        """Reserve the visitor's notice of a new time (its event is `calendar_event`'s); returns the
        budget that is used up instead, if any."""
        return self._try(
            LimitKey(self._policies.reschedule_notices_per_visit, str(visit_id)),
            LimitKey(self._policies.reschedule_notices_per_user_day, str(user_id)),
        )

    def host_visit_notice(self, user_id: UUID) -> PolicyName | None:
        """Reserve one of the acting user's daily host e-mails of a scheduled visit (B14-15; its event is
        `calendar_event`'s or `calendar_removal`'s); returns the budget that is used up instead, if any."""
        return self._try(LimitKey(self._policies.host_visit_notices_per_user_day, str(user_id)))

    def host_new_visit_notice(self, user_id: UUID, company_id: UUID) -> PolicyName | None:
        """Reserve the host's notice of a new visit, which is there for its event (B14-28): one of the
        acting user's daily host e-mails and one of the company's calendar events, both or neither;
        returns the budget that is used up instead, if any."""
        return self._try(
            LimitKey(self._policies.host_visit_notices_per_user_day, str(user_id)),
            self._calendar_event(company_id),
        )

    def calendar_event(self, company_id: UUID) -> PolicyName | None:
        """Reserve one of the company's daily calendar events, for an event that adds the visit to a
        calendar or moves it there; returns the budget that is used up instead, if any."""
        return self._try(self._calendar_event(company_id))

    def calendar_removal(self, company_id: UUID) -> None:
        """Count an event that takes a visit out of a calendar among the company's calendar events while
        the budget has room. It is sent either way (B14-15, B14-16)."""
        self._try(self._calendar_event(company_id))

    def calendar_resend(self, user_id: UUID, visit_id: UUID, company_id: UUID) -> None:
        """Reserve the calendar invitation sent again on its own (B14-31): one of the visit's hourly
        resends, one of the user's daily invitations and one of the company's calendar events, all or
        none, or raise 429 INVITATION_LIMIT."""
        reservation = self._reserve(
            [
                LimitKey(self._policies.invitation_resends_per_visit, str(visit_id)),
                LimitKey(self._policies.invitations_per_user_day, str(user_id)),
                self._calendar_event(company_id),
            ]
        )
        if reservation.denied_by is not None:
            raise InvitationLimit(retry_after=reservation.retry_after, policy=reservation.denied_by.name)

    def withdrawal(self, user_id: UUID, company_id: UUID) -> None:
        """Count the withdrawal of a visitor's event from an address the visitor no longer has (D-19,
        B14-17) among the user's daily invitations and the company's calendar e-mails, each while it has
        room. It is sent either way: refusing it would leave the event in that calendar, and refusing
        the change of address would leave the visit's e-mails going there."""
        self._try(LimitKey(self._policies.invitations_per_user_day, str(user_id)))
        self._try(self._calendar_event(company_id))

    def host_arrival(self, user_id: UUID) -> PolicyName | None:
        """Reserve one of the checking-in user's daily host-arrival e-mails; returns the budget that is
        used up instead, if any."""
        return self._try(LimitKey(self._policies.host_arrivals_per_user_day, str(user_id)))

    def tracking_alert_notice(self, company_id: UUID, visit_id: UUID) -> PolicyName | None:
        """Reserve the first e-mail of an alert's opening or escalation (B16-25): one of the visit's hourly
        alert notices and one of the company's daily tracking-alert e-mails, both or neither; returns the
        budget that is used up instead, if any. Its other recipients take `tracking_alert_email` each."""
        return self._try(
            LimitKey(self._policies.tracking_alert_notices_per_visit, str(visit_id)),
            LimitKey(self._policies.tracking_alert_emails_per_company_day, str(company_id)),
        )

    def tracking_alert_email(self, company_id: UUID) -> PolicyName | None:
        """Reserve one of the company's daily tracking-alert e-mails (B16-15); returns the budget that is used
        up instead, if any."""
        return self._try(LimitKey(self._policies.tracking_alert_emails_per_company_day, str(company_id)))

    def _calendar_event(self, company_id: UUID) -> LimitKey:
        return LimitKey(self._policies.calendar_emails_per_company_day, str(company_id))

    def _try(self, *keys: LimitKey) -> PolicyName | None:
        """Reserve one slot of each key, all or none; the budget that is used up instead, if any."""
        reservation = self._reserve(keys)
        return reservation.denied_by.name if reservation.denied_by is not None else None

    def _reserve(self, keys: Sequence[LimitKey]) -> Reservation:
        reservation = self._limiter.reserve(keys)
        if reservation.granted:
            self._held.append(reservation)
        return reservation

    def settle(self, *, counted: bool) -> None:
        held, self._held = self._held, []
        for reservation in held:
            self._limiter.settle(reservation, counted=counted)


class EmailQuota:
    def __init__(self, limiter: RateLimiter, policies: RatePolicies) -> None:
        self._limiter = limiter
        self._policies = policies

    @contextmanager
    def unit(self) -> Iterator[QuotaUnit]:
        """Reserve inside the block; on a normal exit (after the caller's commit) the slots count, on an
        error they are given back."""
        unit = QuotaUnit(self._limiter, self._policies)
        try:
            yield unit
        except BaseException:
            unit.settle(counted=False)
            raise
        unit.settle(counted=True)
