"""D-17 hook: refresh the name snapshots of SCHEDULED visits when their source changes.

Visits store `host_name`, `department_name` and `department_name_ar` (and the visitor's name/company) as
snapshots: they are
refreshed while a visit is SCHEDULED and frozen from check-in on. The sources of the host and department
names are `UsersService.update_user` and `DepartmentsService.update`, which call the refresher in their
own transaction, before they commit, so a rename and the refreshed snapshots commit or roll back
together. The visitor's snapshots are refreshed by the visitor service, which owns both sides.

Implemented by `services.visit_hooks.VisitSnapshots`, which `create_app` wires.
"""

from datetime import datetime
from typing import Protocol

from sqlalchemy.orm import Session

from app.models import Department, User


class VisitSnapshotRefresher(Protocol):
    def host_renamed(self, db: Session, *, host: User, now: datetime) -> int:
        """Set `host_name` of the host's SCHEDULED visits to `host.full_name`; returns how many changed."""
        ...

    def department_renamed(self, db: Session, *, department: Department, now: datetime) -> int:
        """Set `department_name` and `department_name_ar` of the department's SCHEDULED visits to
        `department.name` and `department.name_ar` (a rename in either language); returns how many
        changed."""
        ...
