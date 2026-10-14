"""Idempotent creation of companies, departments and users for the CLI (seed data and bootstrap).

Seed IDs are deterministic (UUIDv5) so E2E fixtures can rely on them. Re-running a seed adds what is
missing and never changes users or departments. An existing seed company only gains the language fields
of Phase 10 (B10-10): its Arabic name when it has none, and its default language while that is still the
column's default (Arabic). Its name is never changed, except that the demo company's earlier seed name
("Demo Company") becomes the brand's name. Its address is replaced only while it is exactly an earlier
seed's (B10-27: the Arabic address B10-23 wrote becomes the English one again), and its Arabic address
is filled only while it has none and its address is the seed's. Each such change is audited as
COMPANY_SETTINGS_UPDATED with the changed field names, like a change made in the settings page.

A seed never overrides a person (B10-15): a field that someone has changed through the company settings
(a COMPANY_SETTINGS_UPDATED row with an actor names it) is left as it is, even when its value looks like
the earlier seed's. An administrator who chose Arabic for Other Corp, or cleared the Arabic name, keeps
that choice. The audit trail is append-only and never pruned, so the record of that choice stays.

`seed-demo` names its users in Arabic (B10-20: the demo company is Arabic by default) and gives its
departments and its address in both languages (B10-27): the English `name` and `address`, and the Arabic
`name_ar` and `address_ar` that an Arabic interface and the Arabic part of an e-mail show. `seed-e2e`
keeps the English names and address the end-to-end suite reads, without Arabic ones. Every e-mail
address and seed ID stays: a department's seed ID comes from its `key` (its English name), whatever name
it is given. On a database seeded earlier, `seed-demo` renames a seed user only while its name is exactly
an earlier seed's English name, and a seed department only while its name is exactly the Arabic name
B10-20 gave it (back to English, with that Arabic name as `name_ar`); it fills a department's missing
Arabic name while the department has the seed's English name. Nothing is changed that a person changed
(a USER_UPDATED or DEPARTMENT_UPDATED row with an actor naming `full_name`, `name` or `name_ar`, the rule
of B10-15). Each change is audited like a change made in the administration pages, without an actor, and
refreshes the name snapshots of SCHEDULED visits (D-17); a department's change also completes the
snapshots of its checked-in and no-show visits that recorded one of its two seed names (B10-27).

Both seeds also create the platform owner's demo account (Phase 11, B11-3), `platform@demo.local`, with the
seed password and no forced change; a re-run leaves an existing account as it is.

Both seeds give the demo company the Mawdoo3 identity as **its** brand (Phase 12, B12-15): the logo for
light surfaces, the logo for dark surfaces, the square icon (the brand's own files, packaged in
`app/seed_assets` by scripts/demo_brand.py) and the colour #188086. Each image goes through the check an
upload goes through (`app.core.png.sanitize_png`). Only while the company still has its seed names, and
only while no person ever set or removed any part of its brand (a COMPANY_BRAND_UPDATED row that the
platform owner's change left: the rule of B10-15): a company someone renamed, or whose brand the platform
owner touched, is left alone. A re-run stores nothing that is already there. "Other Corp" gets no brand:
the E2E suite needs a company that shows its name as a word mark in the product's default colours.

Seed accounts sign in with a published password that never has to be changed, so they must not exist in
production (B11-36). The seeds refuse to run there, and because that only guards the process that seeds
(a database seeded elsewhere, a restored demo database, a seed run from a workstation against the
production database are not caught by it), the accounts themselves are recognisable: their IDs are
deterministic (`SEED_USER_IDS`, `SEED_PLATFORM_ADMIN_IDS`; no other code path produces them, and no API
lets a tenant choose an ID). `services.seed_guard` refuses to start production on a database that holds
one, and the sign-ins refuse them there. Audit rows the seeds write say `metadata.source = "seed"`; the
rows of `create-admin`, which shares this module's helpers, say `"cli"`.
"""

import hashlib
import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from importlib import resources
from types import MappingProxyType

from sqlalchemy.orm import Session

from app.core import time as app_time
from app.core.png import sanitize_png
from app.core.request_context import SYSTEM_CONTEXT
from app.models import (
    DEFAULT_LANGUAGE,
    BrandAssetKind,
    Company,
    Department,
    Language,
    PlatformAdmin,
    Role,
    User,
    VisitStatus,
)
from app.repositories.audit_logs import AuditLogRepository
from app.repositories.brand import CompanyBrandRepository
from app.repositories.companies import CompanyRepository
from app.repositories.departments import DepartmentRepository
from app.repositories.platform import PlatformAdminRepository
from app.repositories.users import UserRepository
from app.repositories.visits import VisitRepository
from app.schemas.common import ordered_roles
from app.security.passwords import PasswordHasherService
from app.services import audit
from app.services.audit import AuditAction, AuditEntity
from app.services.brand import COLOR_FIELD, IMAGE_LIMITS, new_image_version

_SEED_NAMESPACE = uuid.UUID("6f1c7f0e-8a0b-4d5e-9a57-2f3b1c9e4d21")
DEFAULT_DEMO_PASSWORD = "Demo-Visitor-2026"  # noqa: S105 - documented local default for seeded demo users


def seed_id(*parts: str) -> uuid.UUID:
    return uuid.uuid5(_SEED_NAMESPACE, ":".join(parts))


def seed_user_id(slug: str, email: str) -> uuid.UUID:
    """The ID a seed gives the user `email` of the seed company `slug`."""
    return seed_id(slug, "user", email)


def seed_platform_admin_id(email: str) -> uuid.UUID:
    """The ID a seed gives the platform owner's demo account."""
    return seed_id("platform", email)


@dataclass(frozen=True, slots=True)
class SeedUser:
    email: str
    full_name: str
    roles: tuple[Role, ...]
    department: str | None  # the `key` of a department of the same company
    phone: str | None
    # Names an earlier version of the seed gave this user, which a re-run may replace with `full_name`.
    former_names: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class SeedDepartment:
    key: str  # the source of the seed ID (`seed_id(slug, "department", key)`): never changes
    name: str
    name_ar: str | None = None  # the Arabic name (B10-27)
    # Names an earlier version of the seed gave this department, which a re-run may replace with `name`.
    former_names: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class SeedBrand:
    """A seed company's identity (B12-15): its colour, and the packaged file of each image
    (`app/seed_assets`)."""

    color: str
    images: Mapping[BrandAssetKind, str]


def seed_image(name: str) -> bytes:
    """A packaged brand image of the seeds (`app/seed_assets`, written by scripts/demo_brand.py)."""
    return resources.files("app").joinpath("seed_assets", name).read_bytes()


# The demo company's brand: the Mawdoo3 identity, as a tenant's own (the user's decision of 2026-10-13).
MAWDOO3_BRAND = SeedBrand(
    color="#188086",
    images=MappingProxyType(
        {
            BrandAssetKind.LOGO: "logo.png",
            BrandAssetKind.LOGO_DARK: "logo_dark.png",
            BrandAssetKind.ICON: "icon.png",
        }
    ),
)


@dataclass(frozen=True, slots=True)
class SeedCompany:
    slug: str
    name: str
    address: str
    email_domain: str
    departments: tuple[SeedDepartment, ...]
    users: tuple[SeedUser, ...]
    name_ar: str | None = None
    brand: SeedBrand | None = None  # None: no logo and no colour (the name as a word mark)
    address_ar: str | None = None  # the address in Arabic (B10-27)
    default_language: Language = DEFAULT_LANGUAGE
    # Names an earlier version of the seed gave this company, which a re-run may replace with `name`.
    former_names: tuple[str, ...] = ()
    # Addresses an earlier version of the seed gave this company, which a re-run may replace with `address`.
    former_addresses: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class SeedPlatformAdmin:
    """The platform owner's demo account (B11-3)."""

    email: str
    full_name: str


def _departments(*names: str) -> tuple[SeedDepartment, ...]:
    """Departments named by their keys (English)."""
    return tuple(SeedDepartment(key=name, name=name) for name in names)


# The demo company is the brand's own (Phase 10): Mawdoo3, in Arabic موضوع, with Arabic as its default
# language. The slug, and so every seed ID, stays as it was. `seed-e2e` creates it with the English names
# and address below (E2E_DEMO_COMPANY), which the end-to-end suite reads; `seed-demo` with natural
# Levantine Arabic names for its people (DEMO_COMPANY, B10-20) and its departments and address in both
# languages (B10-27: the English interface shows the English ones, the Arabic interface and the Arabic part
# of every visitor e-mail the Arabic ones).
ENGLISH_DEMO_ADDRESS = "Building 14, King Abdullah II Street, Amman 11953, Jordan"
ARABIC_DEMO_ADDRESS = "مبنى رقم 14، شارع الملك عبدالله الثاني، عمّان 11953، الأردن"


def _demo_company(
    departments: tuple[SeedDepartment, ...],
    users: tuple[SeedUser, ...],
    *,
    address_ar: str | None = None,
    former_addresses: tuple[str, ...] = (),
) -> SeedCompany:
    return SeedCompany(
        slug="demo-company",
        name="Mawdoo3",
        name_ar="موضوع",
        default_language=Language.AR,
        former_names=("Demo Company",),
        address=ENGLISH_DEMO_ADDRESS,
        address_ar=address_ar,
        former_addresses=former_addresses,
        email_domain="demo.local",
        departments=departments,
        users=users,
        brand=MAWDOO3_BRAND,
    )


# (e-mail, English name, Arabic name, roles, department key, phone)
_DEMO_USERS: tuple[tuple[str, str, str, tuple[Role, ...], str | None, str], ...] = (
    ("admin@demo.local", "Amal Haddad", "أمل حداد", (Role.SYSTEM_ADMIN,), "IT", "+962 6 500 1000"),
    ("host@demo.local", "Omar Khalil", "عمر خليل", (Role.EMPLOYEE,), "Finance", "+962 79 500 1001"),
    ("host2@demo.local", "Lina Saleh", "لينا صالح", (Role.EMPLOYEE,), "Operations", "+962 79 500 1002"),
    ("reception@demo.local", "Rami Nasser", "رامي ناصر", (Role.RECEPTIONIST,), None, "+962 6 500 1003"),
    # Holds two roles on purpose: permissions are the union of a user's roles (D-04).
    (
        "manager@demo.local",
        "Dina Farah",
        "دينا فرح",
        (Role.MANAGEMENT, Role.EMPLOYEE),
        "Executive Office",
        "+962 79 500 1004",
    ),
    # MANAGEMENT only: the read-only role exactly as §7.5 defines it.
    (
        "management@demo.local",
        "Nour Abbas",
        "نور عباس",
        (Role.MANAGEMENT,),
        "Executive Office",
        "+962 79 500 1005",
    ),
)
# Department key (English) -> Arabic name.
_DEMO_DEPARTMENTS = {
    "Executive Office": "المكتب التنفيذي",
    "Finance": "المالية",
    "IT": "تقنية المعلومات",
    "Operations": "العمليات",
    "Human Resources": "الموارد البشرية",
}

DEMO_COMPANY = _demo_company(
    # The English name with its Arabic one. The Arabic name alone is what B10-20 gave them; a re-run turns
    # it back into the English name (B10-27).
    departments=tuple(
        SeedDepartment(key=key, name=key, name_ar=arabic, former_names=(arabic,))
        for key, arabic in _DEMO_DEPARTMENTS.items()
    ),
    users=tuple(
        SeedUser(email, arabic, roles, department, phone, former_names=(english,))
        for email, english, arabic, roles, department, phone in _DEMO_USERS
    ),
    address_ar=ARABIC_DEMO_ADDRESS,
    former_addresses=(ARABIC_DEMO_ADDRESS,),  # the address B10-23 wrote
)
E2E_DEMO_COMPANY = _demo_company(
    departments=_departments(*_DEMO_DEPARTMENTS),
    users=tuple(
        SeedUser(email, english, roles, department, phone)
        for email, english, _arabic, roles, department, phone in _DEMO_USERS
    ),
)

# The second tenant of the E2E suite: English by default, without an Arabic name, so the language rules
# (a company's default, `name` standing in for a missing `name_ar`) have a company of each kind.
OTHER_CORP = SeedCompany(
    slug="other-corp",
    name="Other Corp",
    default_language=Language.EN,
    address="22 Al Madina Al Munawara Street, Amman 11185, Jordan",
    email_domain="other.local",
    departments=_departments("Operations", "Finance"),
    users=(
        SeedUser("admin@other.local", "Sami Odeh", (Role.SYSTEM_ADMIN,), "Operations", "+962 6 600 2000"),
        SeedUser("host@other.local", "Huda Mansour", (Role.EMPLOYEE,), "Finance", "+962 79 600 2001"),
        SeedUser("reception@other.local", "Yousef Darwish", (Role.RECEPTIONIST,), None, "+962 6 600 2002"),
        SeedUser(
            "management@other.local", "Rana Qasem", (Role.MANAGEMENT,), "Operations", "+962 79 600 2003"
        ),
    ),
)


# The platform owner's demo account: `seed-demo` names it in Arabic, `seed-e2e` in English (B11-3).
DEMO_PLATFORM_ADMIN = SeedPlatformAdmin("platform@demo.local", "مالك المنصة")
E2E_PLATFORM_ADMIN = SeedPlatformAdmin("platform@demo.local", "Platform Owner")

# Every account a seed creates, by its deterministic ID, with the address the seed gives it (B11-36):
# what `services.seed_guard` looks for in a production database and what the sign-ins refuse there.
SEED_USER_IDS: Mapping[uuid.UUID, str] = MappingProxyType(
    {
        seed_user_id(company.slug, user.email): user.email
        for company in (DEMO_COMPANY, E2E_DEMO_COMPANY, OTHER_CORP)
        for user in company.users
    }
)
SEED_PLATFORM_ADMIN_IDS: Mapping[uuid.UUID, str] = MappingProxyType(
    {seed_platform_admin_id(admin.email): admin.email for admin in (DEMO_PLATFORM_ADMIN, E2E_PLATFORM_ADMIN)}
)


@dataclass(slots=True)
class SeedReport:
    companies_created: list[str] = field(default_factory=list)
    companies_updated: list[str] = field(default_factory=list)
    companies_branded: list[str] = field(default_factory=list)  # given or completed the seed's brand
    departments_created: list[str] = field(default_factory=list)
    departments_updated: list[str] = field(default_factory=list)  # `<slug>/<key>`, renamed or completed
    users_created: list[str] = field(default_factory=list)
    users_updated: list[str] = field(default_factory=list)  # e-mail addresses, renamed
    users_skipped: list[str] = field(default_factory=list)
    platform_admins_created: list[str] = field(default_factory=list)
    platform_admins_skipped: list[str] = field(default_factory=list)


class Seeder:
    def __init__(self, db: Session, *, hasher: PasswordHasherService, source: str = "cli") -> None:
        """`source` is the `metadata.source` of the audit rows written here (rows without an actor):
        "seed" for the seed commands (B11-36), "cli" for `create-admin` (`services.bootstrap`), which
        creates a company and its first administrator with these helpers."""
        self.db = db
        self.hasher = hasher
        self.source = source
        self.companies = CompanyRepository(db)
        self.departments = DepartmentRepository(db)
        self.users = UserRepository(db)
        self.audit_logs = AuditLogRepository(db)
        self.visits = VisitRepository(db)
        self.brands = CompanyBrandRepository(db)

    def seed(
        self,
        specs: Sequence[SeedCompany],
        *,
        timezone: str,
        password: str,
        platform_admins: Sequence[SeedPlatformAdmin] = (),
    ) -> SeedReport:
        report = SeedReport()
        password_hash: str | None = None
        for platform_admin in platform_admins:
            if PlatformAdminRepository(self.db).get_by_email(platform_admin.email) is not None:
                report.platform_admins_skipped.append(platform_admin.email)
                continue
            password_hash = password_hash or self.hasher.hash(password)
            self.ensure_platform_admin(platform_admin, password_hash)
            report.platform_admins_created.append(platform_admin.email)
        for spec in specs:
            company = self.companies.get_by_slug(spec.slug)
            if company is None:
                company = self.ensure_company(
                    slug=spec.slug,
                    name=spec.name,
                    timezone=timezone,
                    address=spec.address,
                    email_domain=spec.email_domain,
                    name_ar=spec.name_ar,
                    address_ar=spec.address_ar,
                    default_language=spec.default_language,
                    report=report,
                )
            else:
                self.complete_company(company, spec, report=report)
            self.ensure_brand(company, spec, report=report)
            departments = {
                department.key: self.ensure_department(company, department, report=report)
                for department in spec.departments
            }
            for user in spec.users:
                existing = self.users.get_by_email(user.email)
                if existing is not None:
                    if self.rename_user(company, existing, user):
                        report.users_updated.append(user.email)
                    else:
                        report.users_skipped.append(user.email)
                    continue
                password_hash = password_hash or self.hasher.hash(password)
                self.create_user(
                    company,
                    email=user.email,
                    full_name=user.full_name,
                    roles=user.roles,
                    department=departments[user.department] if user.department else None,
                    phone=user.phone,
                    password_hash=password_hash,
                    user_id=seed_user_id(spec.slug, user.email),
                )
                report.users_created.append(user.email)
        self.db.commit()
        return report

    def ensure_platform_admin(self, spec: SeedPlatformAdmin, password_hash: str) -> PlatformAdmin:
        admin = PlatformAdminRepository(self.db).add(
            PlatformAdmin(
                id=seed_platform_admin_id(spec.email),
                email=spec.email,
                full_name=spec.full_name,
                password_hash=password_hash,
                is_active=True,
                must_change_password=False,
            )
        )
        audit.record_platform(
            self.db,
            action=AuditAction.PLATFORM_ADMIN_CREATED,
            context=SYSTEM_CONTEXT,
            actor_platform_admin_id=None,
            entity_type=AuditEntity.PLATFORM_ADMIN,
            entity_id=admin.id,
            metadata={"source": self.source},
        )
        return admin

    def ensure_company(
        self,
        *,
        slug: str,
        name: str,
        timezone: str,
        address: str | None,
        email_domain: str | None,
        report: SeedReport,
        name_ar: str | None = None,
        address_ar: str | None = None,
        default_language: Language = DEFAULT_LANGUAGE,
    ) -> Company:
        company = self.companies.get_by_slug(slug)
        if company is not None:
            return company
        company = self.companies.add(
            Company(
                id=seed_id(slug),
                slug=slug,
                name=name,
                name_ar=name_ar,
                default_language=default_language.value,
                timezone=timezone,
                address=address,
                address_ar=address_ar,
                email_domain=email_domain,
            )
        )
        self._audit(company, AuditAction.COMPANY_CREATED, AuditEntity.COMPANY, company.id)
        report.companies_created.append(slug)
        return company

    def complete_company(self, company: Company, spec: SeedCompany, *, report: SeedReport) -> None:
        """Give an existing seed company the seed's language fields where it has none of its own (see the
        module docstring); a name or an address is replaced only when it is one of the seed's former ones,
        and the Arabic address is filled only beside the seed's own address. A field a person has changed
        in the company settings is never touched (B10-15)."""
        chosen = self.audit_logs.fields_changed_by_people(
            company.id, AuditAction.COMPANY_SETTINGS_UPDATED.value, company.id
        )
        changed: list[str] = []
        if "name" not in chosen and company.name in spec.former_names and company.name != spec.name:
            company.name = spec.name
            changed.append("name")
        if "name_ar" not in chosen and company.name_ar is None and spec.name_ar is not None:
            company.name_ar = spec.name_ar
            changed.append("name_ar")
        if (
            "default_language" not in chosen
            and company.default_language == DEFAULT_LANGUAGE.value
            and spec.default_language != DEFAULT_LANGUAGE
        ):
            company.default_language = spec.default_language.value
            changed.append("default_language")
        if (
            "address" not in chosen
            and company.address in spec.former_addresses
            and company.address != spec.address
        ):
            company.address = spec.address
            changed.append("address")
        if (
            "address_ar" not in chosen
            and company.address_ar is None
            and spec.address_ar is not None
            and company.address == spec.address  # the Arabic of the seed's address, not of another one
        ):
            company.address_ar = spec.address_ar
            changed.append("address_ar")
        if not changed:
            return
        self._audit(
            company,
            AuditAction.COMPANY_SETTINGS_UPDATED,
            AuditEntity.COMPANY,
            company.id,
            {"changed_fields": changed, "source": self.source},
        )
        report.companies_updated.append(company.slug)

    def ensure_brand(self, company: Company, spec: SeedCompany, *, report: SeedReport) -> None:
        """Give a seed company the seed's brand (B12-15): each image that is not already the seed's, and
        the colour. Not while the company has other names than the seed's (someone renamed it: it is no
        longer the demo of this brand), and never once a person set or removed any part of its brand
        (B10-15: a seed never overrides a person; here that person is the platform owner). Each image
        passes the check of an upload, and is stored as that check wrote it."""
        if spec.brand is None:
            return
        if company.name != spec.name or company.name_ar != spec.name_ar:
            return
        if self.audit_logs.changed_by_people(company.id, AuditAction.COMPANY_BRAND_UPDATED.value, company.id):
            return
        now = app_time.now()
        stored = self.brands.images(company.id)
        changed: list[str] = []
        for kind, name in spec.brand.images.items():
            image = sanitize_png(seed_image(name), IMAGE_LIMITS[kind])
            digest = hashlib.sha256(image.data).hexdigest()
            if kind in stored and stored[kind].sha256 == digest:
                continue
            self.brands.put(
                company.id,
                kind,
                content=image.data,
                width=image.width,
                height=image.height,
                sha256=digest,
                version=new_image_version(),
                now=now,
            )
            changed.append(kind.value)
        if company.brand_color != spec.brand.color:
            company.brand_color = spec.brand.color
            changed.append(COLOR_FIELD)
        if not changed:
            return
        self._audit(
            company,
            AuditAction.COMPANY_BRAND_UPDATED,
            AuditEntity.COMPANY,
            company.id,
            {"changed_fields": changed, "source": self.source},
        )
        report.companies_branded.append(company.slug)

    def ensure_department(self, company: Company, spec: SeedDepartment, *, report: SeedReport) -> Department:
        """The seed department: found by its seed ID (whatever its name is now), else by its name (one a
        person created), else created."""
        department_id = seed_id(company.slug, "department", spec.key)
        department = self.departments.get(company.id, department_id)
        if department is not None:
            if self.complete_department(company, department, spec):
                report.departments_updated.append(f"{company.slug}/{spec.key}")
            return department
        department = self.departments.get_by_name(company.id, spec.name)
        if department is not None:
            return department
        name_ar = spec.name_ar if spec.name_ar and self._shown_by_no_other(company, spec.name_ar) else None
        department = self.departments.add(
            Department(id=department_id, company_id=company.id, name=spec.name, name_ar=name_ar)
        )
        self._audit(company, AuditAction.DEPARTMENT_CREATED, AuditEntity.DEPARTMENT, department.id)
        report.departments_created.append(f"{company.slug}/{spec.key}")
        return department

    def complete_department(self, company: Company, department: Department, spec: SeedDepartment) -> bool:
        """Give a seed department the seed's names (B10-27): the seed's name while it still has exactly an
        earlier seed's name, and the seed's Arabic name while it has none and its name is the seed's. A
        field a person changed is left alone (B10-15), and so is a name another department already shows.
        Audited and snapshots refreshed (D-17); the department's checked-in and no-show visits that
        recorded one of its two names alone get both (`VisitRepository.complete_department_names`)."""
        chosen = self._changed_by_people(company, AuditAction.DEPARTMENT_UPDATED, department.id)
        changed: list[str] = []
        if (
            "name" not in chosen
            and department.name != spec.name
            and department.name in spec.former_names
            and self._name_free(company, spec.name, department)
        ):
            department.name = spec.name
            changed.append("name")
        if (
            "name_ar" not in chosen
            and department.name_ar is None
            and spec.name_ar is not None
            and department.name == spec.name  # the Arabic of the seed's name, not of a name a person chose
            and self._shown_by_no_other(company, spec.name_ar, department)
        ):
            department.name_ar = spec.name_ar
            changed.append("name_ar")
        if not changed:
            return False
        self.db.flush()
        now = app_time.now()
        self.visits.refresh_department_names(
            company.id, department.id, department.name, department.name_ar, now=now
        )
        if department.name_ar is not None:
            self.visits.complete_department_names(
                company.id,
                department.id,
                department.name,
                department.name_ar,
                statuses=(VisitStatus.CHECKED_IN, VisitStatus.NO_SHOW),
                now=now,
            )
        self._audit(
            company,
            AuditAction.DEPARTMENT_UPDATED,
            AuditEntity.DEPARTMENT,
            department.id,
            {"changed_fields": changed, "source": self.source},
        )
        return True

    def _name_free(self, company: Company, name: str, department: Department) -> bool:
        """No other department of the company has `name` (`uq_departments_company_name`)."""
        taken = self.departments.get_by_name(company.id, name)
        return taken is None or taken.id == department.id

    def _shown_by_no_other(self, company: Company, name: str, department: Department | None = None) -> bool:
        """No other department shows `name` in either language, as its name or as its Arabic name
        (`uq_departments_company_name_ar`): two departments never read the same in the Arabic interface."""
        return all(
            department is not None and other.id == department.id
            for other in self.departments.named(company.id, name)
        )

    def rename_user(self, company: Company, user: User, spec: SeedUser) -> bool:
        """Give a seed user the seed's name while it still has exactly an earlier seed's name and nobody
        renamed them (B10-15); audited, snapshots refreshed (D-17). A user of another company is left
        alone."""
        if user.company_id != company.id or user.full_name == spec.full_name:
            return False
        if user.full_name not in spec.former_names:
            return False
        if "full_name" in self._changed_by_people(company, AuditAction.USER_UPDATED, user.id):
            return False
        user.full_name = spec.full_name
        self.db.flush()
        self.visits.refresh_host_name(company.id, user.id, spec.full_name, now=app_time.now())
        self._audit(
            company,
            AuditAction.USER_UPDATED,
            AuditEntity.USER,
            user.id,
            {"changed_fields": ["full_name"], "source": self.source},
        )
        return True

    def _changed_by_people(self, company: Company, action: AuditAction, entity_id: uuid.UUID) -> set[str]:
        return self.audit_logs.fields_changed_by_people(company.id, action.value, entity_id)

    def create_user(
        self,
        company: Company,
        *,
        email: str,
        full_name: str,
        roles: Sequence[Role],
        department: Department | None,
        phone: str | None,
        password_hash: str,
        user_id: uuid.UUID | None = None,
    ) -> User:
        user = self.users.add(
            User(
                id=user_id or uuid.uuid4(),
                company_id=company.id,
                full_name=full_name,
                email=email,
                phone=phone,
                password_hash=password_hash,
                roles=[role.value for role in ordered_roles(roles)],
                department_id=department.id if department else None,
                is_active=True,
                must_change_password=False,
            )
        )
        self._audit(
            company,
            AuditAction.USER_CREATED,
            AuditEntity.USER,
            user.id,
            {"roles": user.roles, "source": self.source},
        )
        return user

    def _audit(
        self,
        company: Company,
        action: AuditAction,
        entity_type: AuditEntity,
        entity_id: uuid.UUID,
        metadata: Mapping[str, object] | None = None,
    ) -> None:
        audit.record(
            self.db,
            action=action,
            context=SYSTEM_CONTEXT,
            company_id=company.id,
            actor_user_id=None,
            entity_type=entity_type,
            entity_id=entity_id,
            metadata=metadata or {"source": self.source},
        )
