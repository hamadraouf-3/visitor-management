from datetime import datetime

from sqlalchemy import Boolean, CheckConstraint, DateTime, Integer, String, Text, text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.policy import GRACE_MINUTES_MAX
from app.db.base import Base, TimestampMixin, UUIDPrimaryKeyMixin
from app.models.enums import DEFAULT_LANGUAGE, Language, sql_in_list

# A colour as the database and the API hold it: `app.core.palette.is_color` is the same rule, and
# tests/unit/test_palette.py holds the two together.
BRAND_COLOR_PATTERN = "^#[0-9a-f]{6}$"


class Company(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "companies"
    __table_args__ = (
        CheckConstraint(
            f"pass_grace_before_minutes BETWEEN 0 AND {GRACE_MINUTES_MAX}", name="pass_grace_before_range"
        ),
        CheckConstraint(
            f"pass_grace_after_minutes BETWEEN 0 AND {GRACE_MINUTES_MAX}", name="pass_grace_after_range"
        ),
        CheckConstraint(
            "email_domain IS NULL OR (email_domain <> '' AND email_domain = lower(email_domain))",
            name="email_domain_lowercase",
        ),
        CheckConstraint("slug <> '' AND slug = lower(slug)", name="slug_lowercase"),
        CheckConstraint("name_ar IS NULL OR btrim(name_ar) <> ''", name="name_ar_not_blank"),
        CheckConstraint(f"default_language IN ({sql_in_list(Language)})", name="default_language_valid"),
        # A company is deactivated by the platform owner (revision 0013, B11-10): both columns change
        # together.
        CheckConstraint("is_active = (deactivated_at IS NULL)", name="active_matches_deactivated_at"),
        # The company's colour (revision 0015, B12-1): `#rrggbb` in lower case and nothing else, so the
        # value can be written into a style sheet or an e-mail as it is.
        CheckConstraint(
            f"brand_color IS NULL OR brand_color ~ '{BRAND_COLOR_PATTERN}'", name="brand_color_hex"
        ),
    )

    # The English (or only) name; `name_ar` is the Arabic name shown when the interface or an e-mail is in
    # Arabic (B10-1). The service trims both and stores a blank Arabic name as NULL.
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    name_ar: Mapped[str | None] = mapped_column(String(200))
    # The language of the interface for users without a preference, and the leading language of e-mails to
    # visitors and to such users (B10-1, B10-9).
    default_language: Mapped[str] = mapped_column(
        String(2),
        nullable=False,
        default=DEFAULT_LANGUAGE.value,
        server_default=text(f"'{DEFAULT_LANGUAGE.value}'"),
    )
    slug: Mapped[str] = mapped_column(String(80), nullable=False, unique=True)
    # Validated against zoneinfo and pg_timezone_names by the company service.
    timezone: Mapped[str] = mapped_column(String(64), nullable=False)
    address: Mapped[str | None] = mapped_column(Text)
    # The address in Arabic, shown instead of `address` when the interface or an e-mail is in Arabic
    # (revision 0012, B10-25); `address` is the default (English, or only) one.
    address_ar: Mapped[str | None] = mapped_column(Text)
    email_domain: Mapped[str | None] = mapped_column(String(255))
    pass_grace_before_minutes: Mapped[int] = mapped_column(
        Integer, nullable=False, default=60, server_default=text("60")
    )
    pass_grace_after_minutes: Mapped[int] = mapped_column(
        Integer, nullable=False, default=60, server_default=text("60")
    )
    notify_host_on_check_in: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default=text("true")
    )
    allow_walk_ins: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default=text("true")
    )
    # Deactivated by the platform owner (revision 0013, B11-10): its users cannot sign in, their sessions
    # are revoked, and its passes are refused like unknown ones. Reactivation clears `deactivated_at`.
    is_active: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default=text("true")
    )
    deactivated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # The company's colour, chosen by the platform owner (revision 0015, B12-1); NULL: the product's own
    # palette. The shades people see are derived from it (`app.core.palette`). Its logo and icon are rows
    # of `company_brand_assets`.
    brand_color: Mapped[str | None] = mapped_column(String(7))
