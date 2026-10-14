import { chromium, type Page, type Request } from '@playwright/test'
import path from 'node:path'
import type { ScanResult } from '../../src/types/api.ts'
import { passToken } from '../support/api.ts'
import { contextOptions, expect, test } from '../support/fixtures.ts'
import { BASE_URL, CAMERA_DIR, E2E_DIR, PYTHON } from '../support/paths.ts'
import { run } from '../support/processes.ts'
import { minutes } from '../support/time.ts'
import { resultText, scanResult, uniqueTag, waitForApi } from '../support/ui.ts'

/*
 * The real camera path (contract §11): Chromium's fake camera plays a Y4M video of a pass QR code
 * (640 × 480, 4:2:0, written by e2e/support/make_y4m.py with segno), reception's tablet decodes it
 * with the self-hosted zxing decoder and the visitor is checked in. Asserted: exactly one
 * POST /reception/scan while the code stays in view, check-in and back to "ready" within 10 s, and
 * no request leaving the app's origin (no CDN for the decoder, fonts or anything else).
 *
 * Playwright's default headless shell rejects a file-backed fake camera (see playwright.config.ts),
 * so this spec launches Chromium's new headless mode itself (`channel: 'chromium'`).
 */

const MAKE_Y4M = path.join(E2E_DIR, 'support', 'make_y4m.py')

function isScan(request: Request): boolean {
  return request.method() === 'POST' && new URL(request.url()).pathname === '/api/v1/reception/scan'
}

test('the tablet camera reads a pass: one scan request, check-in, ready for the next visitor', async ({ apiAs }) => {
  test.setTimeout(120_000)
  const host = await apiAs('employee')
  const name = `Nour Khatib ${uniqueTag()}`
  const now = Date.now()
  const created = await host.createVisit({
    visitor: { full_name: name, company_name: 'Levant Tech' },
    start: new Date(now - minutes(2)),
    end: new Date(now + minutes(58)),
    purpose: 'Network audit',
  })
  const video = path.join(CAMERA_DIR, `pass-${created.visit.id}.y4m`)
  await run(PYTHON, [MAKE_Y4M, '--text', created.pass_url, '--out', video], { cwd: E2E_DIR, env: process.env })

  const browser = await chromium.launch({
    channel: 'chromium',
    args: ['--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${video}`],
  })
  let page: Page | undefined
  try {
    const context = await browser.newContext(contextOptions(undefined, { as: 'reception', device: 'tablet', options: { permissions: ['camera'] } }))
    const requests: string[] = []
    const scans: number[] = []
    context.on('request', (request) => {
      requests.push(request.url())
      if (isScan(request)) scans.push(Date.now())
    })
    page = await context.newPage()
    const scanned = page.waitForResponse((response) => isScan(response.request()), { timeout: 30_000 })
    await page.goto('/reception')
    // Camera permission is granted, so the camera starts without a tap and decoding begins (§10).
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true)

    const response = await scanned
    expect(response.status()).toBe(200)
    expect(response.request().postDataJSON()).toEqual({ token: passToken(created.pass_url) })
    expect((await response.json()) as ScanResult).toMatchObject({ result: 'READY', visit: { id: created.visit.id } })
    const scannedAt = scans[0]!
    // The decoder ran on the camera's frames: the video element is live.
    expect(await page.evaluate(() => {
      const element = document.querySelector('video')
      return element ? [element.videoWidth, element.videoHeight] : null
    })).toEqual([640, 480])

    const result = scanResult(page)
    await expect(resultText(page, 'Valid pass – ready to check in')).toBeVisible()
    await expect(result.getByRole('heading', { name })).toBeVisible()
    const checkIn = waitForApi(page, 'POST', `/visits/${created.visit.id}/check-in`)
    await result.getByRole('button', { name: 'Check in', exact: true }).click()
    const checkInResponse = await checkIn
    expect(checkInResponse.status()).toBe(200)
    expect(checkInResponse.request().postDataJSON()).toEqual({ method: 'QR', pass_token: passToken(created.pass_url) })
    await expect(resultText(page, 'Checked in')).toBeVisible()
    await expect(resultText(page, 'Ready to scan')).toBeVisible()
    const elapsed = Date.now() - scannedAt
    test.info().annotations.push({ type: 'timing', description: `reception scan → check-in → ready (real camera path, tablet): ${(elapsed / 1000).toFixed(1)} s` })
    expect(elapsed).toBeLessThan(10_000)

    // The code is still in front of the camera: it stays ignored while in view (5 s repeat
    // window, refreshed when decoding resumes), so there is no second scan. Watch for longer than
    // the window.
    await page.waitForTimeout(7_000)
    expect(scans).toHaveLength(1)
    await expect(resultText(page, 'Ready to scan')).toBeVisible()

    const foreign = requests.filter((url) => !url.startsWith(`${BASE_URL}/`) && !url.startsWith('data:') && !url.startsWith('blob:'))
    expect(foreign, 'requests outside the app origin').toEqual([])
    expect(requests.some((url) => url.includes('.wasm'))).toBe(true)
    expect(await host.visit(created.visit.id)).toMatchObject({ status: 'CHECKED_IN', check_in_method: 'QR' })
  } catch (error) {
    if (page) await test.info().attach('camera page at failure', { body: await page.screenshot(), contentType: 'image/png' })
    throw error
  } finally {
    await browser.close()
  }
})
