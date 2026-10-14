#!/usr/bin/env bash
# Back up the Mawdoo3 Visitors database: a timestamped pg_dump archive (custom format), taken as the
# schema owner, verified and checksummed. The counterpart of scripts/backup.ps1 for Linux hosts and
# docker-compose deployments (bash 4.4+, GNU coreutils/findutils); restore with scripts/restore.sh.
#
#   scripts/backup.sh --compose [--out-dir /srv/vms-backups] [--retention-days 14]
#       docker-compose.yml deployment: pg_dump runs inside the postgres container (same major version
#       as the server) over its local socket; the archive streams to the host. Run it from anywhere.
#   scripts/backup.sh [--host db.internal --port 5432] [--db vms] [--user vms_owner] [--out-dir DIR]
#       any reachable server, with the local pg_dump (the server's major version or newer). The password
#       comes from libpq: PGPASSWORD or ~/.pgpass (PGPASSFILE); the script never prompts, so it can run
#       from cron. PGHOST/PGPORT/PGSSLMODE/PGSSLROOTCERT are honoured as usual.
#
# Output: <out-dir>/<db>-<yyyymmddTHHMMSSZ>.dump and .dump.sha256 (sha256sum format), mode 0600 in a
# 0700 folder: the archive holds personal data, password hashes and the audit trail. Copy it off the host
# (encrypted) per the backup policy (docs/decisions/phase-9-deploy.md: RPO/RTO). The archive holds schema,
# data, grants, triggers and the Alembic version, not the roles: provision those first on a new server
# (deploy/postgres/initdb/10-vms-roles.sh).
#
# The dump is one consistent snapshot and does not block the application; it waits at most 60 s for a
# table lock (a migration in progress), then fails rather than queueing behind it.
set -Eeuo pipefail
umask 077

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
compose=false
db=vms
user=vms_owner
host="${PGHOST:-}"
port="${PGPORT:-}"
out_dir="${VMS_BACKUP_DIR:-$REPO/.local/backups}"
retention_days=0
service=postgres

usage() {
    sed -n '2,/^set -E/p' "${BASH_SOURCE[0]}" | sed '$d; s/^# \{0,1\}//'
    exit "${1:-0}"
}
die() {
    printf 'backup.sh: ERROR: %s\n' "$*" >&2
    exit 1
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --compose) compose=true ;;
        --service) service="${2:?}"; shift ;;
        --db) db="${2:?}"; shift ;;
        --user) user="${2:?}"; shift ;;
        --host) host="${2:?}"; shift ;;
        --port) port="${2:?}"; shift ;;
        --out-dir) out_dir="${2:?}"; shift ;;
        --retention-days) retention_days="${2:?}"; shift ;;
        -h | --help) usage 0 ;;
        *) printf 'unknown option: %s\n\n' "$1" >&2; usage 2 ;;
    esac
    shift
done

for pair in "db:$db" "user:$user"; do
    [[ "${pair#*:}" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || die "--${pair%%:*} must be a plain lowercase PostgreSQL identifier"
done
[[ "$retention_days" =~ ^[0-9]+$ ]] || die "--retention-days must be a number of days"

if $compose; then
    command -v docker > /dev/null || die "docker not found"
    compose_cmd=(docker compose --project-directory "$REPO" -f "$REPO/docker-compose.yml")
    pg_dump_cmd=("${compose_cmd[@]}" exec -T "$service" pg_dump "--username=$user" "--dbname=$db")
    pg_restore_list=("${compose_cmd[@]}" exec -T "$service" pg_restore --list)
else
    pg_bin="${PG_BIN:-}"
    if [[ -z "$pg_bin" && -x "$REPO/.local/pgsql/bin/pg_dump.exe" ]]; then pg_bin="$REPO/.local/pgsql/bin"; fi
    tool() {
        if [[ -n "$pg_bin" ]]; then
            if [[ -x "$pg_bin/$1" ]]; then printf '%s' "$pg_bin/$1"; else printf '%s' "$pg_bin/$1.exe"; fi
        else
            command -v "$1" || die "$1 not found (install the PostgreSQL client tools or set PG_BIN)"
        fi
    }
    connection=(--no-password "--username=$user" "--dbname=$db")
    [[ -n "$host" ]] && connection+=("--host=$host")
    [[ -n "$port" ]] && connection+=("--port=$port")
    pg_dump_cmd=("$(tool pg_dump)" "${connection[@]}")
    pg_restore_list=("$(tool pg_restore)" --list)
fi

sha256() {
    if command -v sha256sum > /dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

mkdir -p "$out_dir"
chmod 700 "$out_dir"
out_dir="$(cd "$out_dir" && pwd)"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
name="$db-$stamp.dump"
final="$out_dir/$name"
partial="$final.partial"
[[ ! -e "$final" ]] || die "$final already exists"
trap 'rm -f "$partial"' EXIT

started=$SECONDS
# Custom format: compressed, restorable selectively and in parallel, readable by pg_restore --list.
# From the container the archive streams over stdout; locally pg_dump writes the file itself.
if $compose; then
    "${pg_dump_cmd[@]}" --format=custom --lock-wait-timeout=60s > "$partial" || die "pg_dump failed (nothing was kept)"
    listing="$("${pg_restore_list[@]}" < "$partial")" || die "pg_restore cannot read the archive (nothing was kept)"
else
    "${pg_dump_cmd[@]}" --format=custom --lock-wait-timeout=60s "--file=$partial" || die "pg_dump failed (nothing was kept)"
    listing="$("${pg_restore_list[@]}" "$partial")" || die "pg_restore cannot read the archive (nothing was kept)"
fi

# The archive must be complete and be this application's database.
for expected in 'TABLE DATA public alembic_version' 'TABLE DATA public audit_logs' 'TRIGGER public audit_logs audit_logs_immutable'; do
    grep -qF "$expected" <<< "$listing" || die "the archive does not contain '$expected': is $db the Mawdoo3 Visitors database?"
done
mv "$partial" "$final"
trap - EXIT

hash="$(sha256 "$final")"
printf '%s  %s\n' "$hash" "$name" > "$final.sha256"

if ((retention_days > 0)); then
    # This script's archives of the same database, newest first; the newest is always kept.
    mapfile -t archives < <(find "$out_dir" -maxdepth 1 -type f -regextype posix-extended \
        -regex ".*/$db-[0-9]{8}T[0-9]{6}Z\.dump" -printf '%f\n' | sort -r)
    for old in "${archives[@]:1}"; do
        if [[ -n "$(find "$out_dir/$old" -mtime "+$((retention_days - 1))" -print)" ]]; then
            rm -f "$out_dir/$old" "$out_dir/$old.sha256"
            echo "deleted (older than $retention_days days): $old"
        fi
    done
fi

entries="$(grep -c '^[0-9]' <<< "$listing" || true)"
echo "backup:   $final"
echo "size:     $(($(wc -c < "$final") / 1024)) KiB, $entries archive entries, $((SECONDS - started)) s"
echo "sha256:   $hash"
