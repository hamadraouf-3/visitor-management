"""Revision 0015 at the database (Phase 12, B12-1): the runtime role's grants on a company's brand images,
the CHECKs that repeat the application's limits (whatever writes the row), a removed image as an emptied
row, and a downgrade that refuses to lose a colour or an image, also one still being written."""

import hashlib
import uuid
from collections.abc import Callable

import pytest
from alembic import command
from sqlalchemy import Connection, Engine, create_engine, text
from sqlalchemy.exc import DBAPIError, IntegrityError, ProgrammingError
from sqlalchemy.pool import NullPool

from tests.integration.test_migrations import _downgrade_racing
from tests.png_support import SAMPLE_ICON, SAMPLE_LOGO
from tests.support import ThrowawayDatabase, World, alembic_config

HEAD = "0020"
COMPANY_ID = "00000000-0000-0000-0000-000000000001"
NEW_COMPANY = "INSERT INTO companies (id, name, slug, timezone) VALUES (:id, :name, :slug, 'UTC')"
NEW_IMAGE = (
    "INSERT INTO company_brand_assets "
    "(id, company_id, kind, content, byte_size, width, height, sha256, version) "
    "VALUES (gen_random_uuid(), :company, :kind, :content, :byte_size, :width, :height, :sha256, :version)"
)
CLEARED = (
    "UPDATE company_brand_assets SET content = NULL, byte_size = NULL, width = NULL, height = NULL, "
    "sha256 = NULL, version = NULL"
)


def _image(company: object, **changes: object) -> dict[str, object]:
    """A row as the application stores a logo."""
    row: dict[str, object] = {
        "company": company,
        "kind": "logo",
        "content": SAMPLE_LOGO,
        "byte_size": len(SAMPLE_LOGO),
        "width": 240,
        "height": 80,
        "sha256": hashlib.sha256(SAMPLE_LOGO).hexdigest(),
        "version": "0123456789abcdef",
    }
    row.update(changes)
    return row


def _refused(connection: Connection, statement: str, params: dict | None = None) -> DBAPIError:
    savepoint = connection.begin_nested()
    with pytest.raises(DBAPIError) as caught:
        connection.execute(text(statement), params or {})
    savepoint.rollback()
    return caught.value


# ---- what the runtime role may do ------------------------------------------------------------------------


def test_the_runtime_role_reads_and_writes_brand_images_and_deletes_none(
    connection: Connection, world: World
) -> None:
    privileges = {
        privilege: connection.execute(
            text("SELECT has_table_privilege(current_user, 'company_brand_assets', :privilege)"),
            {"privilege": privilege},
        ).scalar_one()
        for privilege in ("SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER")
    }
    assert privileges == {
        "SELECT": True,
        "INSERT": True,
        "UPDATE": True,
        "DELETE": False,
        "TRUNCATE": False,
        "REFERENCES": False,
        "TRIGGER": False,
    }
    connection.execute(text(NEW_IMAGE), _image(world.a.company.id))
    for statement in ("DELETE FROM company_brand_assets", "TRUNCATE company_brand_assets"):
        error = _refused(connection, statement)
        assert isinstance(error, ProgrammingError) and "permission denied" in str(error.orig)
    # A removed image is the row emptied of the image and of everything about it.
    assert connection.execute(text(CLEARED)).rowcount == 1
    row = connection.execute(
        text("SELECT content, byte_size, width, height, sha256, version, kind FROM company_brand_assets")
    ).one()
    assert tuple(row) == (None, None, None, None, None, None, "logo")


# ---- the colour ------------------------------------------------------------------------------------


@pytest.mark.parametrize("color", ["#000000", "#ffffff", "#188086", "#0a1b2c"])
def test_a_colour_is_stored_as_the_api_spells_it(connection: Connection, world: World, color: str) -> None:
    updated = connection.execute(
        text("UPDATE companies SET brand_color = :color WHERE id = :id"),
        {"color": color, "id": world.a.company.id},
    )
    assert updated.rowcount == 1


@pytest.mark.parametrize(
    "color",
    [
        "",
        "#",
        "#18808",
        "188086",
        "0188086",
        "#18808g",
        "#ABCDEF",
        "#18808 ",
        " #18808",
        "#fff",
        "red",
        "#18;8}6",
        "#1880\n6",
    ],
)
def test_nothing_else_is_stored_as_a_colour(connection: Connection, world: World, color: str) -> None:
    """Whatever writes the row: the value goes into style sheets and e-mails as it is."""
    error = _refused(
        connection,
        "UPDATE companies SET brand_color = :color WHERE id = :id",
        {"color": color, "id": world.a.company.id},
    )
    assert isinstance(error, IntegrityError) and "ck_companies_brand_color_hex" in str(error.orig)


def test_a_longer_value_does_not_fit_the_column(connection: Connection, world: World) -> None:
    for color in ("#1880866", "#188086;background:url(x)", "#188086\n"):
        error = _refused(
            connection,
            "UPDATE companies SET brand_color = :color WHERE id = :id",
            {"color": color, "id": world.a.company.id},
        )
        assert "value too long" in str(error.orig) or "ck_companies_brand_color_hex" in str(error.orig)


# ---- the images ------------------------------------------------------------------------------------

BIG = SAMPLE_LOGO + b"\x00" * (512 * 1024 + 1 - len(SAMPLE_LOGO))


@pytest.mark.parametrize(
    ("changes", "constraint"),
    [
        ({"kind": "banner"}, "ck_company_brand_assets_kind_valid"),
        ({"kind": "LOGO"}, "ck_company_brand_assets_kind_valid"),
        # An image and what describes it: all there, or none.
        ({"content": None}, "ck_company_brand_assets_content_described"),
        ({"byte_size": None}, "ck_company_brand_assets_content_described"),
        ({"width": None}, "ck_company_brand_assets_content_described"),
        ({"height": None}, "ck_company_brand_assets_content_described"),
        ({"sha256": None}, "ck_company_brand_assets_content_described"),
        ({"version": None}, "ck_company_brand_assets_content_described"),
        # A PNG of the size the row says, at most 512 KiB.
        ({"byte_size": len(SAMPLE_LOGO) + 1}, "ck_company_brand_assets_content_png"),
        ({"content": b"<svg onload=alert(1)>", "byte_size": 21}, "ck_company_brand_assets_content_png"),
        ({"content": b"GIF89a" + b"\x00" * 20, "byte_size": 26}, "ck_company_brand_assets_content_png"),
        (
            {"content": SAMPLE_LOGO[1:], "byte_size": len(SAMPLE_LOGO) - 1},
            "ck_company_brand_assets_content_png",
        ),
        ({"content": b"", "byte_size": 0}, "ck_company_brand_assets_content_png"),
        ({"content": BIG, "byte_size": len(BIG)}, "ck_company_brand_assets_content_png"),
        # The contract's sizes.
        ({"width": 31}, "ck_company_brand_assets_dimensions_valid"),
        ({"height": 31}, "ck_company_brand_assets_dimensions_valid"),
        ({"width": 1201}, "ck_company_brand_assets_dimensions_valid"),
        ({"height": 601}, "ck_company_brand_assets_dimensions_valid"),
        ({"width": 0}, "ck_company_brand_assets_dimensions_valid"),
        ({"width": -240}, "ck_company_brand_assets_dimensions_valid"),
        ({"kind": "icon", "width": 191, "height": 191}, "ck_company_brand_assets_dimensions_valid"),
        ({"kind": "icon", "width": 513, "height": 513}, "ck_company_brand_assets_dimensions_valid"),
        ({"kind": "icon", "width": 256, "height": 192}, "ck_company_brand_assets_dimensions_valid"),
        ({"kind": "icon"}, "ck_company_brand_assets_dimensions_valid"),  # 240 x 80 is no icon
        ({"sha256": "A" * 64}, "ck_company_brand_assets_sha256_hex"),
        ({"sha256": "a" * 63 + " "}, "ck_company_brand_assets_sha256_hex"),
        ({"version": "g" * 16}, "ck_company_brand_assets_version_hex"),
        ({"version": "abc"}, "ck_company_brand_assets_version_hex"),
        ({"version": "../../etc/passwd"}, "ck_company_brand_assets_version_hex"),
        ({"company": uuid.UUID(int=7)}, "fk_company_brand_assets_company_id_companies"),
    ],
)
def test_the_image_checks(connection: Connection, world: World, changes: dict, constraint: str) -> None:
    error = _refused(connection, NEW_IMAGE, _image(**{"company": world.a.company.id, **changes}))
    assert isinstance(error, IntegrityError) and constraint in str(error.orig), str(error.orig)[:300]


def test_a_company_has_one_image_of_each_kind(connection: Connection, world: World) -> None:
    connection.execute(text(NEW_IMAGE), _image(world.a.company.id))
    connection.execute(text(NEW_IMAGE), _image(world.a.company.id, kind="logo_dark"))
    icon = {
        "kind": "icon",
        "content": SAMPLE_ICON,
        "byte_size": len(SAMPLE_ICON),
        "width": 192,
        "height": 192,
        "sha256": hashlib.sha256(SAMPLE_ICON).hexdigest(),
    }
    connection.execute(text(NEW_IMAGE), _image(world.a.company.id, **icon))
    connection.execute(text(NEW_IMAGE), _image(world.b.company.id))  # another company's own
    error = _refused(connection, NEW_IMAGE, _image(world.a.company.id))
    assert "uq_company_brand_assets_company_id_kind" in str(error.orig)
    # An emptied row can be filled again, never half.
    assert connection.execute(text(CLEARED)).rowcount == 4
    error = _refused(
        connection, "UPDATE company_brand_assets SET content = :content", {"content": SAMPLE_LOGO}
    )
    assert "ck_company_brand_assets_content_described" in str(error.orig)


# ---- the migration's downgrade ---------------------------------------------------------------------------


def _owner(url: str) -> Engine:
    return create_engine(url, poolclass=NullPool, connect_args={"options": "-c timezone=UTC"})


def _version(connection: Connection) -> str:
    version: str = connection.execute(text("SELECT version_num FROM alembic_version")).scalar_one()
    return version


def _has_brand(connection: Connection) -> tuple[bool, bool]:
    """Whether the table and the column of revision 0015 exist."""
    table = connection.execute(
        text("SELECT to_regclass('public.company_brand_assets') IS NOT NULL")
    ).scalar_one()
    column = connection.execute(
        text(
            "SELECT count(*) FROM information_schema.columns "
            "WHERE table_name = 'companies' AND column_name = 'brand_color'"
        )
    ).scalar_one()
    return bool(table), bool(column)


@pytest.mark.parametrize(
    ("colour", "image", "message"),
    [
        (True, False, "1 company colour(s) and 0 company logo or icon image(s) would be lost"),
        (False, True, "0 company colour(s) and 1 company logo or icon image(s) would be lost"),
        (True, True, "1 company colour(s) and 1 company logo or icon image(s) would be lost"),
    ],
)
def test_the_downgrade_refuses_to_lose_a_colour_or_an_image(
    create_database: Callable[[str], ThrowawayDatabase], colour: bool, image: bool, message: str
) -> None:
    database = create_database("vms_0015")
    config = alembic_config(database)
    command.upgrade(config, "head")
    engine = _owner(database.owner_url)
    try:
        with engine.begin() as connection:
            connection.execute(text(NEW_COMPANY), {"id": COMPANY_ID, "name": "Branded", "slug": "branded"})
            if colour:
                connection.execute(text("UPDATE companies SET brand_color = '#7c3aed'"))
            if image:
                connection.execute(text(NEW_IMAGE), _image(COMPANY_ID))
        with pytest.raises(RuntimeError, match="revision 0015 cannot be downgraded") as refused:
            command.downgrade(config, "0014")
        assert message in str(refused.value)
        with engine.connect() as connection:
            assert _version(connection) == HEAD and _has_brand(connection) == (True, True)
            assert connection.execute(text("SELECT brand_color FROM companies")).scalar_one() == (
                "#7c3aed" if colour else None
            )
        # The statements the refusal names clear the way, and say what is given up.
        with engine.begin() as connection:
            connection.execute(text("UPDATE companies SET brand_color = NULL"))
            connection.execute(text(CLEARED))
        command.downgrade(config, "0014")
        with engine.connect() as connection:
            assert _version(connection) == "0014" and _has_brand(connection) == (False, False)
    finally:
        engine.dispose()


def test_the_downgrade_and_upgrade_of_0015_round_trip(
    create_database: Callable[[str], ThrowawayDatabase],
) -> None:
    database = create_database("vms_0015_round")
    config = alembic_config(database)
    command.upgrade(config, "head")
    engine = _owner(database.owner_url)
    try:
        with engine.begin() as connection:
            connection.execute(text(NEW_COMPANY), {"id": COMPANY_ID, "name": "Kept", "slug": "kept"})
            # A removed image (an emptied row) and no colour block nothing.
            connection.execute(text(NEW_IMAGE), _image(COMPANY_ID))
            connection.execute(text(CLEARED))
        command.downgrade(config, "0014")
        with engine.connect() as connection:
            assert _version(connection) == "0014" and _has_brand(connection) == (False, False)
            assert connection.execute(text("SELECT name FROM companies")).scalar_one() == "Kept"
        command.upgrade(config, "head")
        with engine.begin() as connection:
            assert _version(connection) == HEAD and _has_brand(connection) == (True, True)
            assert connection.execute(text("SELECT brand_color FROM companies")).scalar_one() is None
            assert connection.execute(text("SELECT count(*) FROM company_brand_assets")).scalar_one() == 0
            # The runtime role's grants are back, and no more than before.
            granted = {
                privilege: connection.execute(
                    text("SELECT has_table_privilege(:role, 'company_brand_assets', :privilege)"),
                    {"role": database.app_role, "privilege": privilege},
                ).scalar_one()
                for privilege in ("SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE")
            }
            assert granted == {
                "SELECT": True,
                "INSERT": True,
                "UPDATE": True,
                "DELETE": False,
                "TRUNCATE": False,
            }
            connection.execute(text("UPDATE companies SET brand_color = '#188086'"))
            connection.execute(text(NEW_IMAGE), _image(COMPANY_ID))
            # A company is not deleted from under its images, by any role (ON DELETE RESTRICT).
            savepoint = connection.begin_nested()
            with pytest.raises(IntegrityError, match="fk_company_brand_assets_company_id_companies"):
                connection.execute(text("DELETE FROM companies"))
            savepoint.rollback()
    finally:
        engine.dispose()


@pytest.mark.parametrize(
    "in_flight",
    [
        "UPDATE companies SET brand_color = '#7c3aed' WHERE id = :company".replace(
            ":company", f"'{COMPANY_ID}'"
        ),
        (
            "INSERT INTO company_brand_assets "
            "(id, company_id, kind, content, byte_size, width, height, sha256, version) "
            "VALUES (gen_random_uuid(), :company, 'logo', :content::bytea, :size, 240, 80, :sha256, :version)"
        )
        .replace(":company", f"'{COMPANY_ID}'")
        .replace(":content", f"'\\x{SAMPLE_LOGO.hex()}'")
        .replace(":size", str(len(SAMPLE_LOGO)))
        .replace(":sha256", f"'{hashlib.sha256(SAMPLE_LOGO).hexdigest()}'")
        .replace(":version", "'0123456789abcdef'"),
    ],
    ids=["a colour", "an image"],
)
def test_a_brand_written_during_the_0015_downgrade_still_blocks_it(
    create_database: Callable[[str], ThrowawayDatabase], in_flight: str
) -> None:
    """The guard locks both tables before it counts (SEC-39): a colour or an upload whose transaction is
    still open when the downgrade starts is seen, instead of being dropped with the table."""
    database = create_database("vms_0015_race")
    command.upgrade(alembic_config(database), "head")
    engine = _owner(database.owner_url)
    try:
        with engine.begin() as connection:
            connection.execute(text(NEW_COMPANY), {"id": COMPANY_ID, "name": "Racing", "slug": "racing"})
        refused = _downgrade_racing(database, "0014", in_flight)
        assert isinstance(refused, RuntimeError) and "cannot be downgraded" in str(refused)
        with engine.connect() as connection:
            assert _version(connection) == HEAD and _has_brand(connection) == (True, True)
            kept = connection.execute(
                text(
                    "SELECT (SELECT count(*) FROM companies WHERE brand_color IS NOT NULL) + "
                    "(SELECT count(*) FROM company_brand_assets WHERE content IS NOT NULL)"
                )
            ).scalar_one()
            assert kept == 1
    finally:
        engine.dispose()
