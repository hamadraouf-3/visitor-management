import { APP_PASSWORD, APP_ROLE, OWNER_PASSWORD, OWNER_ROLE, PG_CONNECTION } from './env.ts'
import { PSQL, REPO_ROOT } from './paths.ts'
import { run } from './processes.ts'

/*
 * Direct database access through the portable psql. The schema reset runs as the schema owner
 * (vms_owner, as Alembic does); the checks that read what the API stored run as the runtime role
 * (vms_app), which can read every table but change none of them in a way the tests rely on.
 */

function psqlArgs(role: string): string[] {
  return ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-h', PG_CONNECTION.host, '-p', PG_CONNECTION.port, '-U', role, '-d', PG_CONNECTION.database]
}

async function psql(role: string, password: string, sql: string): Promise<string> {
  const result = await run(PSQL, [...psqlArgs(role), '-f', '-'], {
    cwd: REPO_ROOT,
    env: { ...process.env, PGPASSWORD: password, PGCLIENTENCODING: 'UTF8', PGCONNECT_TIMEOUT: '10' },
    input: sql,
    timeoutMs: 60_000,
  })
  return result.stdout.trim()
}

/**
 * Drops and recreates the `public` schema of the E2E database with the privileges scripts/db.ps1
 * gives it (owned by vms_owner, USAGE for PUBLIC and the runtime role, no TEMPORARY on the
 * database). Alembic then builds the schema from nothing, as on a new deployment.
 */
export async function resetSchema(): Promise<void> {
  await psql(
    OWNER_ROLE,
    OWNER_PASSWORD,
    `
SELECT pg_terminate_backend(pid) FROM pg_stat_activity
 WHERE datname = current_database() AND pid <> pg_backend_pid() AND usename IN ('${OWNER_ROLE}', '${APP_ROLE}');
DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public AUTHORIZATION ${OWNER_ROLE};
GRANT USAGE ON SCHEMA public TO PUBLIC;
GRANT USAGE ON SCHEMA public TO ${APP_ROLE};
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE TEMPORARY ON DATABASE ${PG_CONNECTION.database} FROM PUBLIC;
`,
  )
}

/** Rows of a read-only query as JSON objects (runtime role). */
export async function queryRows<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  const out = await psql(APP_ROLE, APP_PASSWORD, `SELECT coalesce(json_agg(row_to_json(q)), '[]'::json) FROM (${sql}) q;`)
  return JSON.parse(out) as T[]
}

export async function queryOne<T = Record<string, unknown>>(sql: string): Promise<T> {
  const rows = await queryRows<T>(sql)
  if (rows.length !== 1) throw new Error(`Expected one row, got ${rows.length}: ${sql}`)
  return rows[0]!
}

/** A UUID checked before it is put into SQL (the values come from API responses). */
export function uuid(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new Error(`Not a UUID: ${value}`)
  return `'${value}'::uuid`
}
