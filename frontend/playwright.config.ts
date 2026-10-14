import { defineConfig, devices } from '@playwright/test'

/** Ports of their own (§2: automated runs never collide with manual dev on 5173 / 8000). */
const E2E_PORT = 5199
const API_PORT = 8700

/*
 * The full-stack E2E suite (Phase 9; how to run it: docs/decisions/phase-9-e2e.md).
 *
 * - Global setup (e2e/support/global-setup.ts): recreates the `vms_e2e` schema (drop → Alembic →
 *   `cli seed-e2e`), starts the API (`python -m app.serve`) on API_PORT with the outbox e-mail
 *   provider in a fresh per-run directory, signs in every seeded account once (storage states) and
 *   warms up Vite. Global teardown stops the API's whole process tree. Playwright starts and stops the
 *   Vite dev server below, which proxies /api to API_PORT.
 * - Projects: `desktop`, `tablet` and `mobile` are the three viewports of §11 and run the layout specs
 *   (e2e/*.spec.ts, API mocked), the quality specs (e2e/quality: axe, horizontal scroll, dialogs, scan
 *   timing) and, on the tablet, the real-camera spec (e2e/camera). `flows` runs the scenarios
 *   (e2e/flows: the §40 acceptance scenario and the negative cases); each scenario opens a context per
 *   person with the viewport that person uses (reception on a tablet).
 *
 * Real-camera spec (§11): Playwright's default headless Chromium is the headless shell, which cannot
 * play a video file as the camera: with `--use-file-for-fake-video-capture` every getUserMedia rejects
 * with NotSupportedError (the scanner then says camera scanning is not supported here), so the Y4M is
 * never seen. That spec launches the new headless mode itself, with camera permission granted:
 *   chromium.launch({ channel: 'chromium', args: ['--use-fake-device-for-media-stream',
 *     `--use-file-for-fake-video-capture=${y4mPath}`] })
 *   browser.newContext({ permissions: ['camera'], ... })
 * Checked with Playwright 1.63 and Chromium 153.0.8010.12: the headless shell rejects the Y4M device;
 * `channel: 'chromium'` opens it at 640×480@30.
 */

const LAYOUT_SPECS = /e2e[\\/][^\\/]+\.spec\.ts$/
const QUALITY_SPECS = /e2e[\\/]quality[\\/].+\.spec\.ts$/
const CAMERA_SPECS = /e2e[\\/]camera[\\/].+\.spec\.ts$/
const FLOW_SPECS = /e2e[\\/]flows[\\/].+\.spec\.ts$/
/** Dialog footers are checked at 820 and 1440 px (the phone uses bottom sheets, see toast-placement). */
const DIALOG_SPECS = /e2e[\\/]quality[\\/]dialogs\.spec\.ts$/

export default defineConfig({
  testDir: './e2e',
  outputDir: './test-results',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  // No retries: a flaky test is a failure to fix, not to hide.
  retries: 0,
  workers: process.env.E2E_WORKERS ? Number(process.env.E2E_WORKERS) : 4,
  // The JSON report holds every test's annotations (the recorded scan → ready timings) and durations.
  reporter: [['list'], ['html', { outputFolder: './playwright-report', open: 'never' }], ['json', { outputFile: './e2e/.artifacts/results.json' }]],
  globalSetup: './e2e/support/global-setup.ts',
  globalTeardown: './e2e/support/global-teardown.ts',
  expect: { timeout: 10_000 },
  webServer: {
    command: `npx vite --port ${E2E_PORT} --strictPort --host 127.0.0.1`,
    url: `http://127.0.0.1:${E2E_PORT}`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: { VMS_API_PROXY_TARGET: `http://127.0.0.1:${API_PORT}` },
  },
  use: {
    baseURL: `http://127.0.0.1:${E2E_PORT}`,
    // A missing element fails within seconds instead of waiting for the test timeout.
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'desktop',
      testMatch: [LAYOUT_SPECS, QUALITY_SPECS],
      timeout: 60_000,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
    {
      name: 'tablet',
      testMatch: [LAYOUT_SPECS, QUALITY_SPECS, CAMERA_SPECS],
      timeout: 60_000,
      use: { ...devices['Desktop Chrome'], viewport: { width: 820, height: 1180 }, hasTouch: true },
    },
    {
      name: 'mobile',
      testMatch: [LAYOUT_SPECS, QUALITY_SPECS],
      testIgnore: DIALOG_SPECS,
      timeout: 60_000,
      use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 }, hasTouch: true },
    },
    {
      name: 'flows',
      testMatch: FLOW_SPECS,
      timeout: 180_000,
      // The browser's zone differs from the company's (Asia/Amman) on purpose: every time the UI
      // shows or accepts must be company wall time whatever the device's zone.
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, timezoneId: 'America/Los_Angeles' },
    },
  ],
})
