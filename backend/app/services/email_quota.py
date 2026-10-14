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

Cancellation notices have no budget of their own: one goes out at most once per visit whose invitation
was requested (and counted), so the invitation budget bounds them.

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
        """Reserve a reschedule notice; returns the budget that is used up instead, if any."""
        reservation = self._reserve(
            [
                LimitKey(self._policies.reschedule_notices_per_visit, str(visit_id)),
                LimitKey(self._policies.reschedule_notices_per_user_day, str(user_id)),
            ]
        )
        return reservation.denied_by.name if reservation.denied_by is not None else None

    def host_arrival(self, user_id: UUID) -> PolicyName | None:
        """Reserve one of the checking-in user's daily host-arrival e-mails; returns the budget that is
        used up instead, if any."""
        reservation = self._reserve([LimitKey(self._policies.host_arrivals_per_user_day, str(user_id))])
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
