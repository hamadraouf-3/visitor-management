import { BACKEND_PORT, BASE_URL, OUTBOX_DIR, WEB_PORT } from './paths.ts'

/*
 * The environment of every backend process the suite starts: the API server, Alembic, the seed and
 * the time-travel CLI. Values are explicit so nothing depends on the developer's `.env` (environment
 * variables take precedence over it in pydantic-settings).
 */

const PG_HOST = process.env.VMS_PG_HOST ?? 'localhost'
const PG_PORT = process.env.VMS_PG_PORT ?? '5433'
export const E2E_DATABASE = process.env.VMS_E2E_DATABASE ?? 'vms_e2e'
export const OWNER_ROLE = 'vms_owner'
export const APP_ROLE = 'vms_app'
export const OWNER_PASSWORD = process.env.VMS_PG_OWNER_PASSWORD ?? 'vms_owner_local_dev'
export const APP_PASSWORD = process.env.VMS_PG_APP_PASSWORD ?? 'vms_app_local_dev'

export const PG_CONNECTION = { host: PG_HOST, port: PG_PORT, database: E2E_DATABASE }

/** EMAIL_FAIL_DOMAIN: invitations to this domain fail permanently (contract §9). */
export const FAIL_DOMAIN = 'fail.test'

/** The seeded users' password (seed-e2e). */
export const SEED_PASSWORD = process.env.SEED_DEMO_PASSWORD ?? 'Demo-Visitor-2026'

/** Set by the global setup (one random key per run) and inherited by the workers. */
export const SECRET_KEY_ENV = 'VMS_E2E_SECRET_KEY'

/** The defaults of `.env.example` (contract §7.3 and the Phase 8 additions). */
const RATE_LIMIT_DEFAULTS = {
  RATE_LIMIT_ENABLED: 'true',
  RATE_LIMIT_LOGIN_PER_IP_EMAIL: '5',
  RATE_LIMIT_LOGIN_PER_IP: '30',
  RATE_LIMIT_LOGIN_PER_ACCOUNT: '10',
  RATE_LIMIT_LOGIN_SUCCESSES_PER_ACCOUNT: '30',
  RATE_LIMIT_PASSWORD_CHANGE_PER_USER: '5',
  RATE_LIMIT_PASSWORD_CHANGES_PER_HOUR: '5',
  RATE_LIMIT_USER_EMAIL_REFUSALS_PER_HOUR: '10',
  RATE_LIMIT_FORGOT_PER_EMAIL: '3',
  RATE_LIMIT_FORGOT_PER_IP: '10',
  RATE_LIMIT_RESET_PER_IP: '20',
  RATE_LIMIT_SCAN_PER_MINUTE: '120',
  RATE_LIMIT_ATTENDANCE_REFUSALS_PER_MINUTE: '30',
  RATE_LIMIT_RESENDS_PER_VISIT_HOUR: '3',
  RATE_LIMIT_API_PER_MINUTE: '600',
  INVITATION_DAILY_LIMIT: '50',
  RESCHEDULE_NOTICE_DAILY_LIMIT: '50',
  RATE_LIMIT_RESCHEDULE_NOTICES_PER_VISIT_HOUR: '3',
  HOST_ARRIVAL_DAILY_LIMIT: '500',
  // Phase 12: the public brand endpoints (per client address a minute) and the platform owner's brand changes (an hour).
  RATE_LIMIT_PUBLIC_BRAND_PER_IP: '600',
  RATE_LIMIT_PUBLIC_BRAND_PER_PREFIX: '6000',
  RATE_LIMIT_BRAND_CHANGES_PER_HOUR: '120',
} as const

const url = (role: string, password: string) =>
  `postgresql+psycopg://${role}:${encodeURIComponent(password)}@${PG_HOST}:${PG_PORT}/${E2E_DATABASE}`

export function backendEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    APP_ENV: 'development',
    DATABASE_URL: url(APP_ROLE, APP_PASSWORD),
    MIGRATION_DATABASE_URL: url(OWNER_ROLE, OWNER_PASSWORD),
    DB_APP_ROLE: APP_ROLE,
    DB_REQUIRE_TLS: 'false',
    SECRET_KEY: process.env[SECRET_KEY_ENV] ?? '',
    APP_BASE_URL: BASE_URL,
    QR_BASE_URL: BASE_URL,
    ALLOWED_ORIGINS: `${BASE_URL},http://localhost:${WEB_PORT}`,
    // The Vite proxy connects from loopback and adds X-Forwarded-For (xfwd), as in development.
    TRUSTED_PROXIES: '127.0.0.1/32,::1/128',
    COOKIE_SECURE: 'false',
    SERVER_HOST: '127.0.0.1',
    SERVER_PORT: String(BACKEND_PORT),
    EMAIL_PROVIDER: 'outbox',
    EMAIL_OUTBOX_DIR: OUTBOX_DIR,
    EMAIL_FAIL_DOMAIN: FAIL_DOMAIN,
    // The address every e-mail is sent from. Its display name is the product's, which only the
    // platform's own notices keep: a company's e-mails are sent in the company's name (B12-13).
    EMAIL_FROM: 'Mawdoo3 Visitors <no-reply@demo.local>',
    EMAIL_REPLY_TO: '',
    RESEND_API_KEY: '',
    // Rate limits stay on with their documented defaults (set here so a developer's `.env` cannot
    // change them): the suite reuses one session per seeded account (storage states), so it stays
    // below every per-account and per-IP budget.
    ...RATE_LIMIT_DEFAULTS,
    // The calendar e-mails (Phase 14) are on, as by default; production starts with them off (its
    // deploy template). Set here so a developer's `.env` cannot turn off what the suite checks.
    CALENDAR_INVITATIONS_ENABLED: 'true',
    LOG_LEVEL: 'INFO',
    LOG_JSON: 'true',
    SEED_COMPANY_TIMEZONE: 'Asia/Amman',
    SEED_DEMO_PASSWORD: SEED_PASSWORD,
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
  }
}
