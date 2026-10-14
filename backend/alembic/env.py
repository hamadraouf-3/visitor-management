"""Alembic environment.

Migrations run as the schema owner (MIGRATION_DATABASE_URL). Callers that drive Alembic
programmatically (tests, tooling) may pass `database_url`, `app_role` and `configure_logging=False`
through `Config.attributes`; logging is then left untouched so existing loggers keep working.
"""

from logging.config import fileConfig

from alembic import context
from sqlalchemy import Connection, create_engine, pool

import app.models  # noqa: F401 - registers every table on the metadata
from app.core.config import get_settings
from app.db.base import Base
from app.db.session import connection_options

config = context.config

if config.config_file_name is not None and config.attributes.get("configure_logging", True):
    fileConfig(config.config_file_name, disable_existing_loggers=False)

target_metadata = Base.metadata


def _database_url() -> str:
    url = config.attributes.get("database_url")
    return url if url else get_settings().migration_url


def _ensure_app_role() -> None:
    # The initial revision grants runtime privileges to this role (DB_APP_ROLE, default vms_app).
    if not config.attributes.get("app_role"):
        config.attributes["app_role"] = get_settings().db_app_role


def _configure(connection: Connection | None = None, url: str | None = None) -> None:
    context.configure(
        connection=connection,
        url=url,
        target_metadata=target_metadata,
        compare_type=True,
        compare_server_default=True,
        literal_binds=connection is None,
        dialect_opts={"paramstyle": "named"} if connection is None else {},
    )


def run_migrations_offline() -> None:
    _ensure_app_role()
    _configure(url=_database_url())
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    _ensure_app_role()
    connection = config.attributes.get("connection")
    if connection is not None:
        _configure(connection=connection)
        with context.begin_transaction():
            context.run_migrations()
        return

    engine = create_engine(
        _database_url(),
        poolclass=pool.NullPool,
        hide_parameters=True,
        # The application's session settings (`app.db.session.SESSION_SETTINGS`): the downgrade guards
        # count rows after locking the table, which needs READ COMMITTED whatever the defaults are.
        connect_args={"options": connection_options(), "application_name": "vms-migrations"},
    )
    try:
        with engine.connect() as conn:
            _configure(connection=conn)
            with context.begin_transaction():
                context.run_migrations()
    finally:
        engine.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
