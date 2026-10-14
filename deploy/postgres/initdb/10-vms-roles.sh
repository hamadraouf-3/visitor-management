#!/usr/bin/env bash
# PostgreSQL provisioning for Mawdoo3 Visitors (contract §1, §4; docs/decisions/phase-9-deploy.md).
#
# docker-compose.yml mounts this directory at /docker-entrypoint-initdb.d of the postgres container. The
# image's entrypoint runs it ONCE, as the superuser over the local socket, while initialising an empty
# data directory. It creates the grants model the application relies on (the same as scripts/db.ps1 for
# development):
#
#   VMS_OWNER_ROLE (vms_owner)  LOGIN. Owns the database and the public schema; runs the migrations
#                               (MIGRATION_DATABASE_URL) and `app.cli prune-sessions`. No CREATEDB,
#                               CREATEROLE or SUPERUSER in production.
#   VMS_APP_ROLE   (vms_app)    LOGIN, nothing else: no attribute, no membership, no default settings,
#                               no TEMPORARY, no CREATE anywhere. Its table privileges come from the
#                               migrations (DML only; INSERT/SELECT on audit_logs). The API refuses to
#                               start in production if this role has more (app/db/privileges.py).
#   VMS_DB_NAME    (vms)        owned by the owner role; only the two roles may connect.
#
# Passwords: VMS_OWNER_PASSWORD and VMS_APP_PASSWORD, or VMS_OWNER_PASSWORD_FILE / VMS_APP_PASSWORD_FILE
# (Docker secrets). They must match the passwords in MIGRATION_DATABASE_URL and DATABASE_URL.
#
# Works whether the entrypoint executes it or sources it (a checkout without the executable bit): the
# body runs in a subshell, so no shell option or variable leaks into the entrypoint. Outside the
# container (tests) it honours the usual libpq variables (PGHOST, PGPORT, PGPASSWORD).

vms_provision_database() (
    set -Eeuo pipefail

    fail() {
        printf '10-vms-roles.sh: ERROR: %s\n' "$*" >&2
        exit 1
    }

    # VAR or VAR_FILE (not both), like the postgres image's own POSTGRES_PASSWORD(_FILE).
    secret() {
        local var="$1" file_var="${1}_FILE"
        if [[ -n "${!var:-}" && -n "${!file_var:-}" ]]; then
            fail "set $var or $file_var, not both"
        fi
        if [[ -n "${!file_var:-}" ]]; then
            [[ -r "${!file_var}" ]] || fail "$file_var: ${!file_var} is not readable"
            # The file's content without trailing newlines.
            printf '%s' "$(<"${!file_var}")"
        else
            printf '%s' "${!var:-}"
        fi
    }

    identifier() {
        local name="$1" value="$2"
        [[ "$value" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] ||
            fail "$name must be a plain lowercase PostgreSQL identifier, got '$value'"
    }

    password() {
        local name="$1" value="$2"
        ((${#value} >= 24)) || fail "$name must have at least 24 characters (generate one: openssl rand -base64 32)"
        [[ "${value,,}" != *local_dev* ]] || fail "$name is the published local-development password"
    }

    local db="${VMS_DB_NAME:-vms}" owner="${VMS_OWNER_ROLE:-vms_owner}" app="${VMS_APP_ROLE:-vms_app}"
    identifier VMS_DB_NAME "$db"
    identifier VMS_OWNER_ROLE "$owner"
    identifier VMS_APP_ROLE "$app"
    [[ "$owner" != "$app" ]] || fail "VMS_OWNER_ROLE and VMS_APP_ROLE must differ"

    local owner_password app_password
    owner_password="$(secret VMS_OWNER_PASSWORD)"
    app_password="$(secret VMS_APP_PASSWORD)"
    password VMS_OWNER_PASSWORD "$owner_password"
    password VMS_APP_PASSWORD "$app_password"
    [[ "$owner_password" != "$app_password" ]] || fail "the owner and runtime roles need different passwords"

    # The passwords reach psql through its environment (\getenv), never its command line. The session
    # does not log statements, and a failing statement is not logged either: its text holds a password.
    VMS_INIT_OWNER_PASSWORD="$owner_password" VMS_INIT_APP_PASSWORD="$app_password" \
        psql --no-psqlrc --set ON_ERROR_STOP=1 --quiet \
        --username "${POSTGRES_USER:-postgres}" --dbname postgres \
        --set db="$db" --set owner="$owner" --set app="$app" <<'SQL'
SET log_statement = 'none';
SET log_min_error_statement = 'panic';
\getenv owner_password VMS_INIT_OWNER_PASSWORD
\getenv app_password VMS_INIT_APP_PASSWORD

CREATE ROLE :"owner" LOGIN PASSWORD :'owner_password';
CREATE ROLE :"app" LOGIN PASSWORD :'app_password';
\unset owner_password
\unset app_password

-- template0: the cluster's encoding and locale (builtin C.UTF-8 collation, UTF-8 ctype), nothing else.
CREATE DATABASE :"db" OWNER :"owner" TEMPLATE template0;
-- Only the two roles may connect; nobody else gets TEMPORARY (the migration 0008 revokes it as well).
REVOKE ALL ON DATABASE :"db" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"db" TO :"owner", :"app";

\connect :"db"
SET log_statement = 'none';
-- No DDL for the runtime role: the schema belongs to the owner, everybody else may only use it.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
ALTER SCHEMA public OWNER TO :"owner";
GRANT USAGE ON SCHEMA public TO :"app";
SQL

    printf '10-vms-roles.sh: created roles %s (owner) and %s (runtime) and database %s\n' "$owner" "$app" "$db"
)

vms_provision_database
