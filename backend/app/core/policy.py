"""Business limits shared by models, schemas and services (one definition each)."""

from datetime import timedelta

# Admin-issued temporary passwords expire after this long (D-11).
TEMPORARY_PASSWORD_TTL = timedelta(hours=72)

# Upper bound for the company pass grace periods before/after a visit (contract §4, minutes).
GRACE_MINUTES_MAX = 1440

# Visit schedule rules (D-14): not in the past (with a small tolerance for the time it takes to submit a
# form), at most 24 hours long, at most 365 days ahead.
SCHEDULE_PAST_TOLERANCE = timedelta(minutes=5)
MAX_VISIT_DURATION = timedelta(hours=24)
MAX_SCHEDULE_AHEAD = timedelta(days=365)

# Reason recorded on visits cancelled because their host was deactivated or lost the host role (D-18).
HOST_UNAVAILABLE_REASON = "Host is no longer available"

# Look-back of the employee dashboard's completed/cancelled counts (contract §8.1 EmployeeDashboard).
DASHBOARD_RECENT_DAYS = 30

# Visits listed inline in a response (dashboard today list, a visitor's visits today).
INLINE_VISIT_LIST_CAP = 200
