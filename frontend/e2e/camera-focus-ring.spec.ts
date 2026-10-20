import { expect, test, type Page } from '@playwright/test'
import type { Me, ReceptionToday } from '../src/types/api.ts'
import { colorAt, contrastRatio, describeRing, expectVisibleRing, focusIndicator, focusVisibly, hexToRgb } from './support/focus-ring.ts'
import { UNBRANDED } from './support/mock-brand.ts'

/*
 * The reception scanner's controls on the camera preview keep a visible focus ring whatever the
 * picture under them (WCAG 1.4.11). Finding of the accessibility audit: the ring of "Turn camera
 * off" was white and lies on the live picture, 1.14:1 on a bright frame (#eef0f2) on all four
 * sides. It is two-tone now, white between dark bands (`focus-ring-on-media`), like every control
 * in the preview ("Start camera" and "Try again" on the dark panel).
 *
 * The camera is a canvas stream of one color, changed per check, so the frame under the ring is
 * known: bright, white, the mid grey where each tone of the ring has the least contrast, and black.
 * Measured on screen (support/focus-ring.ts): on each side, the pixels that change with focus and
 * their contrast against what was there before, the frame. The API is mocked, so this spec needs
 * only the Vite server.
 */

const ME: Me = {
  user: {
    id: '00000000-0000-4000-8000-000000000001',
    full_name: 'Rana Saleh',
    email: 'rana.saleh@example.com',
    phone: null,
    roles: ['RECEPTIONIST'],
    department: null,
    must_change_password: false,
    preferred_language: null,
  },
  company: { id: '00000000-0000-4000-8000-0000000000c1', name: 'Demo Holdings', name_ar: null, slug: 'demo-holdings', timezone: 'Asia/Amman', default_language: 'en', brand: UNBRANDED, address: null, address_ar: null },
}

const TODAY: ReceptionToday = {
  date: '2026-10-06',
  counts: { expected: 0, inside: 0, checked_out: 0, no_show: 0, cancelled: 0, walk_ins: 0 },
  expected: [],
  inside: [],
  checked_out: [],
  no_show: [],
}

const FRAMES: Record<string, string> = { bright: '#eef0f2', white: '#ffffff', 'mid grey': '#767676', black: '#000000' }

/** Replaces the camera with a canvas stream showing one color, `window.e2eFrameColor`. */
function fakeCamera() {
  const state = window as unknown as { e2eFrameColor: string }
  state.e2eFrameColor = '#000000'
  if (!navigator.mediaDevices) Object.defineProperty(navigator, 'mediaDevices', { value: {} })
  navigator.mediaDevices.getUserMedia = async () => {
    const canvas = document.createElement('canvas')
    canvas.width = 640
    canvas.height = 480
    const context = canvas.getContext('2d')
    if (!context) throw new Error('No 2D canvas context')
    const paint = () => {
      context.fillStyle = state.e2eFrameColor
      context.fillRect(0, 0, canvas.width, canvas.height)
    }
    paint()
    setInterval(paint, 30)
    return canvas.captureStream(30)
  }
  navigator.mediaDevices.enumerateDevices = async () => []
}

async function showFrame(page: Page, hex: string, at: { x: number; y: number }) {
  await page.evaluate((color) => Object.assign(window, { e2eFrameColor: color }), hex)
  const expected = hexToRgb(hex)
  await expect.poll(async () => contrastRatio(await colorAt(page, at), expected), { message: `the preview shows ${hex}` }).toBeLessThan(1.05)
}

test('the camera controls keep a focus ring of at least 3:1 on all four sides, on a bright and a dark picture', async ({ page }, testInfo) => {
  await page.addInitScript(fakeCamera)
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname.replace('/api/v1', '')
    if (path === '/auth/me') return route.fulfill({ json: ME })
    if (path === '/reception/today') return route.fulfill({ json: TODAY })
    return route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: 'Not mocked.', details: {} }, request_id: 'e2e' } })
  })
  await page.goto('/reception')
  const measured: string[] = []

  // "Start camera" on the dark panel (the picture is hidden while the camera is off).
  const start = page.getByRole('button', { name: 'Start camera' })
  await focusVisibly(page, start)
  const startRing = await focusIndicator(page, start)
  measured.push(`Start camera on the panel: ${describeRing(startRing)}`)
  expectVisibleRing(startRing, 'Start camera')

  await page.keyboard.press('Enter')
  const turnOff = page.getByRole('button', { name: 'Turn camera off' })
  await expect(page.getByText('Point the camera at the visitor’s QR code')).toBeVisible()
  await expect(turnOff).toBeVisible()
  const box = (await turnOff.boundingBox())!
  // The picture beside the button (left of it, at its middle): away from the framing marks.
  const picture = { x: box.x - 24, y: box.y + box.height / 2 }

  for (const [name, hex] of Object.entries(FRAMES)) {
    await test.step(`${name} frame ${hex}`, async () => {
      await showFrame(page, hex, picture)
      const ring = await focusIndicator(page, turnOff)
      measured.push(`Turn camera off on ${hex}: ${describeRing(ring)}`)
      expectVisibleRing(ring, `Turn camera off on a ${name} frame (${hex})`)
    })
  }
  testInfo.annotations.push({ type: 'focus ring contrast', description: measured.join(' | ') })
})
