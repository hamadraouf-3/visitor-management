"""Collaborators the services share. `create_app` builds one instance (`app.state.service_environment`);
request dependencies and the D-18 hook all use it."""

from dataclasses import dataclass, field

from sqlalchemy.orm import Session

from app.core.config import Settings
from app.core.rate_limit import RateLimiter, RatePolicies
from app.email.logos import LogoWarmUp
from app.email.rendering import EmailRenderer
from app.email.service import EmailService
from app.services.email_quota import EmailQuota
from app.services.tracking_provider import DisabledProvider, TrackingProvider


@dataclass(frozen=True, slots=True)
class ServiceEnvironment:
    settings: Settings
    renderer: EmailRenderer
    email_provider_name: str
    limiter: RateLimiter
    policies: RatePolicies
    # Draws the e-mails' logos ahead of the requests that send them (B13-7): in the application as
    # `python -m app.serve` runs it, not in one a test builds.
    logo_warm_up: LogoWarmUp | None = None
    # The Visitor Journey's tracking provider (`TRACKING_PROVIDER`, Phase 15, B15-1): disabled unless the
    # application was built with another.
    tracking: TrackingProvider = field(default_factory=DisabledProvider)

    def email_service(self, db: Session) -> EmailService:
        return EmailService(
            db, settings=self.settings, renderer=self.renderer, provider_name=self.email_provider_name
        )

    def email_quota(self) -> EmailQuota:
        return EmailQuota(self.limiter, self.policies)
