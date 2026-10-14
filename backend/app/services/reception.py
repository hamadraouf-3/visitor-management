"""Reception lists (contract §8 GET /reception/today, GET /reception/inside, §8.1 `ReceptionToday`).

Today is the company-local calendar day. The NO_SHOW marking runs first, so the lists show current
states:
* expected: SCHEDULED visits whose pass works before the end of today, i.e. whose window opens before it
  (their windows are still open, so a visit that started before midnight and has not ended yet is still
  expected, and so is one starting just after midnight, or tomorrow with a long grace period, whose pass
  is already valid or becomes valid today: SEC-R2), earliest start first;
* inside: every CHECKED_IN visit, whatever the day of its check-in (stale ones are flagged `is_stale`),
  earliest check-in first;
* checked_out: visits checked out today, latest first;
* no_show: today's visits that became NO_SHOW (an OVERRIDE can still check them in today);
* counts: the same sets counted exactly, plus today's cancelled visits and walk-ins.
Each list holds at most `LIST_CAP` visits. The evacuation list (GET /reception/inside) is never capped:
it must name everyone in the building, and it gives each visitor's current phone so that a missing
visitor can be called (B57-72).
"""

from itertools import accumulate

from sqlalchemy.orm import Session

from app.core import time as app_time
from app.core.time import company_day_bounds, local_date
from app.repositories.visits import VisitRepository
from app.schemas.reception import LIST_CAP, InsideList, ReceptionCounts, ReceptionToday
from app.security.sessions import AuthContext
from app.services.no_shows import mark_no_shows_committed
from app.services.visit_views import Viewer, VisitViewBuilder


class ReceptionService:
    def __init__(self, db: Session) -> None:
        self.db = db
        self.visits = VisitRepository(db)

    def today(self, auth: AuthContext) -> ReceptionToday:
        now = app_time.now()
        mark_no_shows_committed(self.db, auth.company_id, now=now)
        viewer = Viewer.of(auth)
        day = local_date(now, viewer.timezone)
        start, end = company_day_bounds(day, viewer.timezone)
        company_id = auth.company_id
        counts = self.visits.reception_counts(company_id, day_start=start, day_end=end)
        expected_rows = self.visits.expected_until(company_id, end, limit=LIST_CAP)
        inside_rows = self.visits.inside(company_id, limit=LIST_CAP)
        checked_out_rows = self.visits.checked_out_between(company_id, start, end, limit=LIST_CAP)
        no_show_rows = self.visits.no_shows_starting_between(company_id, start, end, limit=LIST_CAP)
        # One batch for the four lists, so the view builder's queries run once.
        views = VisitViewBuilder(self.db, viewer, now=now).build(
            [*expected_rows, *inside_rows, *checked_out_rows, *no_show_rows]
        )
        bounds = list(accumulate((len(expected_rows), len(inside_rows), len(checked_out_rows))))
        expected, inside, checked_out, no_show = (
            views[: bounds[0]],
            views[bounds[0] : bounds[1]],
            views[bounds[1] : bounds[2]],
            views[bounds[2] :],
        )
        return ReceptionToday(
            date=day,
            counts=ReceptionCounts(
                expected=counts.expected,
                inside=counts.inside,
                checked_out=counts.checked_out,
                no_show=counts.no_show,
                cancelled=counts.cancelled,
                walk_ins=counts.walk_ins,
            ),
            expected=expected,
            inside=inside,
            checked_out=checked_out,
            no_show=no_show,
        )

    def inside(self, auth: AuthContext) -> InsideList:
        """Everyone checked in, for the evacuation list (D-25): uncapped, with `is_stale` / `is_overdue`
        and each visitor's current phone (B57-72; the callers read every visitor, §7.5)."""
        now = app_time.now()
        mark_no_shows_committed(self.db, auth.company_id, now=now)
        visits = self.visits.inside(auth.company_id)
        items = VisitViewBuilder(self.db, Viewer.of(auth), now=now).build_inside(visits)
        return InsideList(count=len(items), items=items)
