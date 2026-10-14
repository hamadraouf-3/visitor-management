"""Results of service calls whose e-mails are delivered after the commit (contract §3.2-1)."""

from dataclasses import dataclass

from app.email.service import DeliveryJob


@dataclass(frozen=True, slots=True)
class Mutation[T]:
    """A change's response payload and the e-mail jobs the route schedules once it has committed."""

    payload: T
    delivery_jobs: tuple[DeliveryJob, ...] = ()
