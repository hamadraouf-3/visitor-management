#!/usr/bin/env bash
# Restore a scripts/backup.sh (or backup.ps1) archive into a NEW database and verify it: schema version,
# row counts, triggers and the runtime role's privileges. The counterpart of scripts/restore.ps1 for Linux
# hosts and docker-compose deployments (bash 4.4+).
#
#   scripts/restore.sh --compose --file backups/vms-20261006T020000Z.dump --target-db vms_restore
#       docker-compose.yml deployment: the archive is copied into the postgres container and restored
#       there; the superuser creates the database over the container's local socket.
#   scripts/restore.sh --file vms-....dump --target-db vms_restore [--host H --port P] [--user vms_owner]
#       any reachable server, with the local tools; passwords from libpq (PGPASSWORD / ~/.pgpass).
#       Options: --app-role vms_app, --admin-user ROLE (creates the database; default --user, which then
#       needs CREATEDB), --maintenance-db postgres, --require-checksum.
#
# Never touches an existing database (the target must not exist). Steps: verify the .sha256 (when
# present) and that pg_restore can read the archive; create the database (owner --user, template0: the
# cluster's UTF-8 / builtin C.UTF-8 locale) with the provisioning's database-level grants (only the
# owner and the runtime role may connect; no TEMPORARY for anyone else; public schema owned by the owner,
# usable by the runtime role); restore in ONE transaction (on failure the new database is dropped);
# ANALYZE; verify. Roles are not in an archive: provision them first on a new server.
#
# Switching the application to the restored database is a separate step: stop the API, point
# DATABASE_URL / MIGRATION_DATABASE_URL at it (or rename databases), start the API (it refuses to start
# when the runtime role's privileges are wrong). See docs/decisions/phase-9-deploy.md.
set -Eeuo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
compose=false
file=""
target=""
user=vms_owner
app_role=vms_app
admin_user=""
maintenance_db=postgres
host="${PGHOST:-}"
port="${PGPORT:-}"
require_checksum=false
service=postgres

usage() {
    sed -n '2,/^set -E/p' "${BASH_SOURCE[0]}" | sed '$d; s/^# \{0,1\}//'
    exit "${1:-0}"
}
die() {
    printf 'restore.sh: ERROR: %s\n' "$*" >&2
    exit 1
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --compose) compose=true ;;
        --service) service="${2:?}"; shift ;;
        --file) file="${2:?}"; shift ;;
        --target-db) target="${2:?}"; shift ;;
        --user) user="${2:?}"; shift ;;
        --app-role) app_role="${2:?}"; shift ;;
        --admin-user) admin_user="${2:?}"; shift ;;
        --maintenance-db) maintenance_db="${2:?}"; shift ;;
        --host) host="${2:?}"; shift ;;
        --port) port="${2:?}"; shift ;;
        --require-checksum) require_checksum=true ;;
        -h | --help) usage 0 ;;
        *) printf 'unknown option: %s\n\n' "$1" >&2; usage 2 ;;
    esac
    shift
done

[[ -n "$file" && -n "$target" ]] || usage 2
[[ -f "$file" ]] || die "$file not found"
if [[ -z "$admin_user" ]]; then
    if $compose; then admin_user=postgres; else admin_user="$user"; fi
fi
for pair in "target-db:$target" "user:$user" "app-role:$app_role" "admin-user:$admin_user" "maintenance-db:$maintenance_db"; do
    [[ "${pair#*:}" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || die "--${pair%%:*} must be a plain lowercase PostgreSQL identifier"
done

if $compose; then
    command -v docker > /dev/null || die "docker not found"
    compose_cmd=(docker compose --project-directory "$REPO" -f "$REPO/docker-compose.yml")
    in_container=/tmp/vms-restore-$$.dump
    psql_cmd=("${compose_cmd[@]}" exec -T "$service" psql)
    pg_restore_cmd=("${compose_cmd[@]}" exec -T "$service" pg_restore)
    archive="$in_container"
    connection=()
else
    pg_bin="${PG_BIN:-}"
    if [[ -z "$pg_bin" && -x "$REPO/.local/pgsql/bin/psql.exe" ]]; then pg_bin="$REPO/.local/pgsql/bin"; fi
    tool() {
        if [[ -n "$pg_bin" ]]; then
            if [[ -x "$pg_bin/$1" ]]; then printf '%s' "$pg_bin/$1"; else printf '%s' "$pg_bin/$1.exe"; fi
        else
            command -v "$1" || die "$1 not found (install the PostgreSQL client tools or set PG_BIN)"
        fi
    }
    psql_cmd=("$(tool psql)")
    pg_restore_cmd=("$(tool pg_restore)")
    archive="$file"
    connection=(--no-password)
    [[ -n "$host" ]] && connection+=("--host=$host")
    [[ -n "$port" ]] && connection+=("--port=$port")
fi
# SQL goes in on stdin so that psql variables (:"name", :'value') quote every identifier and value.
psql_as() {
    local role="$1" database="$2"
    shift 2
    "${psql_cmd[@]}" "${connection[@]}" --no-psqlrc --quiet --tuples-only --no-align --set=ON_ERROR_STOP=1 \
        "--username=$role" "--dbname=$database" "$@"
}

sha256() {
    if command -v sha256sum > /dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

# 1. The archive ------------------------------------------------------------------------------------
if [[ -f "$file.sha256" ]]; then
    expected="$(cut -d' ' -f1 < "$file.sha256" | tr 'A-F' 'a-f')"
    actual="$(sha256 "$file")"
    [[ "$expected" == "$actual" ]] || die "checksum mismatch for $file (expected $expected, got $actual): do not restore this file"
    echo "checksum: OK ($actual)"
elif $require_checksum; then
    die "$file.sha256 is missing"
else
    echo "restore.sh: WARNING: no $file.sha256 next to the archive: integrity not checked" >&2
fi
if $compose; then
    listing="$("${pg_restore_cmd[@]}" --list < "$file")" || die "pg_restore cannot read $file"
else
    listing="$("${pg_restore_cmd[@]}" --list "$file")" || die "pg_restore cannot read $file"
fi
grep -qF 'TABLE DATA public alembic_version' <<< "$listing" || die "$file is not a Mawdoo3 Visitors archive (no alembic_version)"

# 2. The new database -------------------------------------------------------------------------------
exists="$(psql_as "$admin_user" "$maintenance_db" --set=db="$target" <<< "SELECT count(*) FROM pg_database WHERE datname = :'db';" | tr -d '\r')"
[[ "$exists" == "0" ]] || die "database $target already exists: restore into a new database"

created=false
cleanup() {
    local status=$?
    if $compose; then "${compose_cmd[@]}" exec -T "$service" rm -f "$in_container" > /dev/null 2>&1 || true; fi
    if ((status != 0)) && $created; then
        echo "restore.sh: restore failed; dropping the new database $target" >&2
        psql_as "$admin_user" "$maintenance_db" --set=db="$target" <<< 'DROP DATABASE :"db";' ||
            echo "restore.sh: could not drop $target; drop it by hand" >&2
    fi
}
trap cleanup EXIT

started=$SECONDS
psql_as "$admin_user" "$maintenance_db" --set=db="$target" --set=owner="$user" \
    <<< 'CREATE DATABASE :"db" OWNER :"owner" TEMPLATE template0;'
created=true
psql_as "$user" "$target" --set=db="$target" --set=owner="$user" --set=app="$app_role" << 'SQL'
REVOKE ALL ON DATABASE :"db" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"db" TO :"owner", :"app";
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
ALTER SCHEMA public OWNER TO :"owner";
GRANT USAGE ON SCHEMA public TO :"app";
SQL

# 3. One transaction: either everything is restored or nothing is. ------------------------------------
if $compose; then
    "${compose_cmd[@]}" cp "$file" "$service:$in_container"
fi
"${pg_restore_cmd[@]}" "${connection[@]}" "--username=$user" "--dbname=$target" \
    --single-transaction --exit-on-error "$archive"
# Restored: a failed verification below keeps the database for inspection (it must not be used).
created=false

# 4. Statistics and verification --------------------------------------------------------------------
report="$(psql_as "$user" "$target" --set=app="$app_role" << 'SQL'
SELECT format('ANALYZE public.%I;', c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' \gexec
SELECT 'schema version: ' || string_agg(version_num, ',') FROM alembic_version;
SELECT 'triggers: ' || string_agg(tgname || '=' || tgenabled::text, ', ' ORDER BY tgname) FROM pg_trigger WHERE NOT tgisinternal;
SELECT 'runtime role: ' || concat_ws(', ',
    'insert audit_logs=' || has_any_column_privilege(:'app', 'public.audit_logs', 'INSERT'),
    'update audit_logs=' || has_table_privilege(:'app', 'public.audit_logs', 'UPDATE'),
    'delete audit_logs=' || has_table_privilege(:'app', 'public.audit_logs', 'DELETE'),
    'update visits=' || has_table_privilege(:'app', 'public.visits', 'UPDATE'),
    'delete visits=' || has_table_privilege(:'app', 'public.visits', 'DELETE'),
    'temporary=' || has_database_privilege(:'app', current_database(), 'TEMPORARY'),
    'create in public=' || has_schema_privilege(:'app', 'public', 'CREATE'));
SELECT 'rows: ' || string_agg(c.relname || '=' || (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM public.%I', c.relname), false, true, '')))[1]::text, ', ' ORDER BY c.relname)
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r';
SQL
)"
report="$(tr -d '\r' <<< "$report" | sed '/^[[:space:]]*$/d')"
echo "$report"

problems=()
for trigger in 'audit_logs_immutable=O' 'visits_terminal_immutable=O'; do
    grep '^triggers:' <<< "$report" | grep -qF "$trigger" || problems+=("trigger $trigger missing or disabled")
done
expected_role='runtime role: insert audit_logs=true, update audit_logs=false, delete audit_logs=false, update visits=true, delete visits=false, temporary=false, create in public=false'
role="$(grep '^runtime role:' <<< "$report" || true)"
[[ "$role" == "$expected_role" ]] || problems+=("runtime role privileges differ from the migrations' grants: $role")
grep -q '^schema version: .' <<< "$report" || problems+=("no schema version")
if ((${#problems[@]} > 0)); then
    die "restored database $target failed verification (kept for inspection; do not use it): ${problems[*]}"
fi
echo "restored: $file -> $target in $((SECONDS - started)) s (verified)"
