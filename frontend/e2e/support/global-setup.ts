import { chromium, request, type APIRequestContext, type FullConfig } from '@playwright/test'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { LANGUAGE_STORAGE_KEY } from '../../src/i18n/languages.ts'
import { ACCOUNT_KEYS, ACCOUNTS, PLATFORM_ACCOUNT, platformStorageStatePath, storageStatePath } from './accounts.ts'
import { resetSchema } from './db.ts'
import { backendEnv, SECRET_KEY_ENV, SEED_PASSWORD } from './env.ts'
import {
  ARTIFACTS_DIR,
  BACKEND_DIR,
  BACKEND_LOG,
  BACKEND_PID_FILE,
  BACKEND_PORT,
  BACKEND_URL,
  BASE_URL,
  CAMERA_DIR,
  OUTBOX_DIR,
  PYTHON,
  RUN_DIR,
  STATE_DIR,
} from './paths.ts'
import { isPortFree, killTree, run, startBackground, waitForHealthy, waitForPortFree } from './processes.ts'
import { createQualityData, qualityData } from './quality-data.ts'
import { prepareTracking } from './tracking.ts'

/*
 * Full-stack E2E global setup (contract §11): a fresh `vms_e2e` schema (drop → Alembic → seed-e2e),
 * the API on its own port with the outbox e-mail provider writing to a fresh per-run directory, one
 * signed-in storage state per seeded account, the UI pinned to English (`pinEnglish`), and a
 * warmed-up Vite dev server. Playwright starts the
 * Vite webServer (with VMS_API_PROXY_TARGET) before this runs; the global teardown stops the API.
 */

function log(message: string) {
  process.stdout.write(`[e2e setup] ${message}\n`)
}

/** A server left over by an interrupted run still holds the port and the database. */
function stopLeftoverBackend() {
  if (!existsSync(BACKEND_PID_FILE)) return
  const pid = Number(readFileSync(BACKEND_PID_FILE, 'utf8'))
  if (Number.isInteger(pid) && pid > 0) {
    log(`stopping the API server left by an earlier run (pid ${pid})`)
    killTree(pid)
  }
  rmSync(BACKEND_PID_FILE, { force: true })
}

async function prepareDatabase() {
  const env = backendEnv()
  log('recreating the vms_e2e schema')
  await resetSchema().catch((error: unknown) => {
    throw new Error(`Could not reset the vms_e2e database. Is PostgreSQL running (./scripts/db.ps1 start)?\n${String(error)}`)
  })
  log('alembic upgrade head')
  await run(PYTHON, ['-m', 'alembic', 'upgrade', 'head'], { cwd: BACKEND_DIR, env, timeoutMs: 180_000 })
  log('seed-e2e')
  await run(PYTHON, ['-m', 'app.cli', 'seed-e2e'], { cwd: BACKEND_DIR, env, timeoutMs: 120_000 })
}

async function startBackend() {
  if (!(await isPortFree(BACKEND_PORT))) {
    await waitForPortFree(BACKEND_PORT, 10_000).catch(() => {
      throw new Error(`Port ${BACKEND_PORT} is in use. Stop whatever listens on it before running the E2E suite.`)
    })
  }
  log(`starting the API on ${BACKEND_URL}`)
  const child = startBackground(PYTHON, ['-m', 'app.serve', '--host', '127.0.0.1', '--port', String(BACKEND_PORT)], {
    cwd: BACKEND_DIR,
    env: backendEnv(),
    logFile: BACKEND_LOG,
  })
  if (!child.pid) throw new Error('The API server could not be started')
  writeFileSync(BACKEND_PID_FILE, String(child.pid))
  try {
    await waitForHealthy(`${BACKEND_URL}/api/v1/health`, { timeoutMs: 60_000, child, logFile: BACKEND_LOG })
    // The same check through the Vite proxy: the browser's path to the API.
    await waitForHealthy(`${BASE_URL}/api/v1/health`, { timeoutMs: 30_000, logFile: BACKEND_LOG })
  } catch (error) {
    killTree(child.pid)
    rmSync(BACKEND_PID_FILE, { force: true })
    throw error
  }
}

/** One sign-in per seeded account; every test reuses these sessions (no per-test logins). */
async function signInAccounts() {
  for (const key of ACCOUNT_KEYS) {
    const context = await request.newContext({ baseURL: BASE_URL })
    try {
      const response = await context.post('/api/v1/auth/login', { data: { email: ACCOUNTS[key].email, password: SEED_PASSWORD } })
      if (!response.ok()) throw new Error(`Signing in ${ACCOUNTS[key].email} failed: ${response.status()} ${await response.text()}`)
      await context.storageState({ path: storageStatePath(key) })
    } finally {
      await context.dispose()
    }
  }
  log(`signed in ${ACCOUNT_KEYS.length} seeded accounts`)
}

/**
 * The platform owner (Phase 11): its own sign-in endpoint and cookies. Its language stays unset, so the
 * platform pages follow the device's (`en` below): the specs read them in English.
 */
async function signInPlatform() {
  const context = await request.newContext({ baseURL: BASE_URL })
  try {
    const response = await context.post('/api/v1/platform/auth/login', { data: { email: PLATFORM_ACCOUNT.email, password: SEED_PASSWORD } })
    if (!response.ok()) throw new Error(`Signing in ${PLATFORM_ACCOUNT.email} to the platform failed: ${response.status()} ${await response.text()}`)
    const me = (await response.json()) as { admin?: { preferred_language?: unknown } }
    if (me.admin?.preferred_language !== null) throw new Error(`The platform account has a language of its own (${String(me.admin?.preferred_language)}); the specs read English`)
    await context.storageState({ path: platformStorageStatePath() })
  } finally {
    await context.dispose()
  }
  log('signed in the platform owner')
}

/** The CSRF cookie of a signed-in request context (sent back as X-CSRF-Token on unsafe requests). */
async function csrfToken(context: APIRequestContext): Promise<string> {
  const cookie = (await context.storageState()).cookies.find((candidate) => candidate.name === '__Host-vms_csrf' || candidate.name === 'vms_csrf')
  if (!cookie) throw new Error('No CSRF cookie in the signed-in state')
  return cookie.value
}

/**
 * The specs read the English UI (phase 10, F10-12), while the seed gives both companies Arabic as
 * their default language, as the product has. Pinned here, once per run:
 * - each company's `default_language` is set to English through its administrator, so every user
 *   without a preference sees English, also the users a scenario creates;
 * - every storage state carries the device language `en` (`localStorage`), for the pages before
 *   sign-in; a context without a storage state gets English from the browser's language (en-US).
 * The Arabic smoke spec (e2e/i18n-smoke.spec.ts) switches its own user, never these. The pin is
 * checked: an API that does not store the language fails the setup instead of leaving the specs
 * to meet an Arabic UI.
 */
async function pinEnglish() {
  for (const key of ['admin', 'otherAdmin'] as const) {
    const context = await request.newContext({ baseURL: BASE_URL, storageState: storageStatePath(key) })
    try {
      const patched = await context.patch('/api/v1/company/settings', {
        data: { default_language: 'en' },
        headers: { 'X-CSRF-Token': await csrfToken(context) },
      })
      if (!patched.ok()) throw new Error(`Pinning ${ACCOUNTS[key].company} to English failed: ${patched.status()} ${await patched.text()}`)
      const settings = (await patched.json()) as { default_language?: unknown }
      if (settings.default_language !== 'en') {
        throw new Error(`Pinning ${ACCOUNTS[key].company} to English failed: the API answered default_language=${String(settings.default_language)}`)
      }
    } finally {
      await context.dispose()
    }
  }
  for (const file of [...ACCOUNT_KEYS.map(storageStatePath), platformStorageStatePath()]) {
    const state = JSON.parse(readFileSync(file, 'utf8')) as { cookies: unknown[]; origins: { origin: string; localStorage: { name: string; value: string }[] }[] }
    state.origins = [{ origin: BASE_URL, localStorage: [{ name: LANGUAGE_STORAGE_KEY, value: 'en' }] }]
    writeFileSync(file, JSON.stringify(state, null, 2))
  }
  log('pinned the UI language to English')
}

/**
 * Opens the lazily loaded routes once, so the Vite dev server has transformed them and settled its
 * dependency pre-bundling before the first test (a re-optimisation reloads open pages).
 */
async function warmUpVite() {
  const browser = await chromium.launch()
  try {
    const context = await browser.newContext({ baseURL: BASE_URL, storageState: storageStatePath('admin') })
    const page = await context.newPage()
    for (const path of ['/login', '/pass', '/reception', '/visits/new', '/reports', '/admin/audit', '/history', '/inside', '/visitors', '/admin/email-templates', '/admin/email-templates/VISITOR_INVITATION', '/journey', '/admin/tracking']) {
      await page.goto(path, { waitUntil: 'networkidle', timeout: 120_000 })
    }
    // A visit's journey (Phase 15): its own lazy module.
    await page.goto(`/journey/${qualityData().trackedVisitId}`, { waitUntil: 'networkidle', timeout: 120_000 })
    await context.close()
    // The platform owner's area (Phase 11): its own lazy modules.
    const platform = await browser.newContext({ baseURL: BASE_URL, storageState: platformStorageStatePath() })
    const platformPage = await platform.newPage()
    for (const path of ['/platform/companies', '/platform/companies/new', '/platform/audit', '/platform/change-password']) {
      await platformPage.goto(path, { waitUntil: 'networkidle', timeout: 120_000 })
    }
    // A company's identity and e-mail texts in the platform area (Phase 12): their own lazy modules.
    const listed = await platform.request.get('/api/v1/platform/companies')
    if (!listed.ok()) throw new Error(`Listing the companies for the warm-up failed: ${listed.status()} ${await listed.text()}`)
    const company = ((await listed.json()) as { items: { id: string; slug: string }[] }).items[0]
    if (!company) throw new Error('The platform lists no company to warm the identity pages up with')
    for (const section of ['identity', 'email-templates', 'email-templates/VISITOR_INVITATION']) {
      await platformPage.goto(`/platform/companies/${company.id}/${section}`, { waitUntil: 'networkidle', timeout: 120_000 })
    }
    await platform.close()
    const signedOut = await browser.newContext({ baseURL: BASE_URL })
    const signedOutPage = await signedOut.newPage()
    // A company's sign-in page and pass (Phase 12), then the platform's sign-in page.
    for (const path of [`/c/${company.slug}`, `/pass?c=${company.slug}`, '/platform/login']) {
      await signedOutPage.goto(path, { waitUntil: 'networkidle', timeout: 120_000 })
    }
    await signedOut.close()
  } finally {
    await browser.close()
  }
  log('Vite dev server warmed up')
}

export default async function globalSetup(_config: FullConfig) {
  const started = Date.now()
  stopLeftoverBackend()
  rmSync(RUN_DIR, { recursive: true, force: true })
  for (const dir of [ARTIFACTS_DIR, RUN_DIR, OUTBOX_DIR, STATE_DIR, CAMERA_DIR]) mkdirSync(dir, { recursive: true })
  // One random key per run, inherited by the workers (time-travel CLI) through the environment.
  process.env[SECRET_KEY_ENV] = randomBytes(48).toString('base64url')

  await prepareDatabase()
  await startBackend()
  await signInAccounts()
  await signInPlatform()
  await pinEnglish()
  await prepareTracking()
  log('prepared the Visitor Journey (tracking on, a building, its cameras)')
  await createQualityData()
  log('created the quality specs’ visits')
  await warmUpVite()
  log(`ready in ${((Date.now() - started) / 1000).toFixed(1)} s (outbox: ${OUTBOX_DIR})`)
}
