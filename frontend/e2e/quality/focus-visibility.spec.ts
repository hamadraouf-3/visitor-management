import type { Locator, Page } from '@playwright/test'
import { storageStatePath, type AccountKey } from '../support/accounts.ts'
import { expect, test } from '../support/fixtures.ts'
import { contrastRatio, describeRing, expectVisibleRing, focusIndicator, type Rgb } from '../support/focus-ring.ts'

/*
 * Keyboard focus stays visible (WCAG 1.4.11, 2.4.11), with real data from the running API:
 *
 * - F9-3: the selected tab's focus ring shows on all four sides at ≥ 3:1, on /reception and
 *   /visits, at the project's viewport (1440 and 820: the tab list scrolls sideways and clipped the
 *   ring outside the tab, so it is drawn inside; 390: the phone grid keeps it outside). Measured
 *   on screen, focused against blurred (support/focus-ring.ts).
 * - Phase 10 review: the admin dashboard's dark "Inside now" tile (a link) drew its ring in the dark
 *   tile's light turquoise on the light canvas (1.73:1); it takes the page's focus colour now. The
 *   skip link showed as a pill without padding over the logo, its teal ring on the teal shell: it has
 *   its padding, and its ring lies inside the pill.
 * - F9-4 / F9-8: a Tab walk through the company settings and the reception walk-in form at
 *   320 × 720 and 390 × 700. No focused control, its 4 px ring included (for a visually hidden
 *   radio, the segment label that draws the ring), lies under the sticky action bar
 *   (`[data-sticky-actions]`). Measured in the first animation frame after each Tab, where the bar's
 *   reveal runs, before that frame is painted. The walk-in tab panel itself is taller than the
 *   screen and is left out, as the bar's reveal leaves it.
 */

test.describe.configure({ mode: 'parallel' })

interface FocusPage {
  label: string
  account: AccountKey
  path: string
  ready: (page: Page) => Locator
}

async function load(page: Page, check: FocusPage) {
  await page.goto(check.path)
  await expect(check.ready(page)).toBeVisible()
  await expect(page.locator('[role="status"] .animate-spin')).toHaveCount(0)
  await page.waitForLoadState('networkidle')
}

const TAB_PAGES: (FocusPage & { tabs: string })[] = [
  { label: 'reception', account: 'reception', path: '/reception', tabs: 'Reception', ready: (page) => page.getByText('Ready to scan') },
  { label: 'my visits', account: 'employee', path: '/visits', tabs: 'Visits', ready: (page) => page.getByRole('heading', { level: 1, name: 'My visits' }) },
]

for (const check of TAB_PAGES) {
  test.describe(check.label, () => {
    test.use({ storageState: storageStatePath(check.account) })
    test(`${check.label}: the selected tab's focus ring shows on all four sides (F9-3)`, async ({ page }, testInfo) => {
      await load(page, check)
      const tab = page.getByRole('tablist', { name: check.tabs }).getByRole('tab', { selected: true })
      // Inside the tab (scrolling list) or outside it (phone grid): look 6 px each way.
      const ring = await focusIndicator(page, tab, { inside: 6, outside: 6 })
      testInfo.annotations.push({ type: 'focus ring contrast', description: `${check.path}: ${describeRing(ring)}` })
      expectVisibleRing(ring, `${check.path} selected tab`)
    })
  })
}

/** "rgb(24, 128, 134)" → [24, 128, 134]. */
function rgb(color: string): Rgb {
  return (color.match(/\d+(?:\.\d+)?/g) ?? []).slice(0, 3).map(Number) as Rgb
}

test.describe('admin dashboard', () => {
  test.use({ storageState: storageStatePath('admin') })

  test('the dark "Inside now" tile’s focus ring shows on all four sides on the light canvas (phase 10 review)', async ({ page }, testInfo) => {
    await load(page, { label: 'admin', account: 'admin', path: '/admin', ready: (p) => p.getByRole('heading', { level: 1, name: 'Admin dashboard' }) })
    const tile = page.getByRole('main').getByRole('link', { name: /^Inside now/ })
    const ring = await focusIndicator(page, tile, { outside: 6 })
    testInfo.annotations.push({ type: 'focus ring contrast', description: `/admin Inside now tile: ${describeRing(ring)}` })
    expectVisibleRing(ring, '/admin "Inside now" tile')
  })

  test('the skip link is a padded pill with its focus ring inside it (phase 10 review)', async ({ page }) => {
    await load(page, { label: 'admin', account: 'admin', path: '/admin', ready: (p) => p.getByRole('heading', { level: 1, name: 'Admin dashboard' }) })
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await page.keyboard.press('Tab')
    const skip = page.getByRole('link', { name: 'Skip to main content' })
    await expect(skip).toBeFocused()
    const style = await skip.evaluate((element) => {
      const computed = getComputedStyle(element)
      return {
        padding: [computed.paddingTop, computed.paddingInlineStart, computed.paddingBottom, computed.paddingInlineEnd].map(Number.parseFloat),
        outlineWidth: Number.parseFloat(computed.outlineWidth),
        outlineOffset: Number.parseFloat(computed.outlineOffset),
        outline: computed.outlineColor,
        background: computed.backgroundColor,
      }
    })
    expect(style.padding, 'padding top, start, bottom, end in px').toEqual([8, 16, 8, 16])
    // Inside the pill: the ring is drawn on the pill's own surface, whatever lies behind it (the teal shell).
    expect(style.outlineOffset + style.outlineWidth).toBeLessThanOrEqual(0)
    expect(contrastRatio(rgb(style.outline), rgb(style.background)), `ring ${style.outline} on ${style.background}`).toBeGreaterThanOrEqual(3)
  })
})

interface Stop {
  name: string
  /** `checked`; or left out: inside the bar, the walk-in tab panel, the page itself (end of the walk). */
  kind: 'checked' | 'bar' | 'panel' | 'end' | 'repeat'
  /** Pixels of the control and its ring under the bar. */
  covered: number
}

/** Where focus is, measured in the first animation frame after it moved. */
function measureStop(page: Page): Promise<Stop> {
  return page.evaluate(
    () =>
      new Promise<Stop>((resolve) => {
        requestAnimationFrame(() => {
          const control = document.activeElement
          if (!(control instanceof HTMLElement) || control === document.body) {
            resolve({ name: 'the page', kind: 'end', covered: 0 })
            return
          }
          const state = window as unknown as { e2eFocusStops?: WeakSet<Element> }
          const seen = (state.e2eFocusStops ??= new WeakSet())
          const label = control.getAttribute('aria-label') ?? (control as HTMLInputElement).labels?.[0]?.textContent ?? control.textContent ?? ''
          const name = `${control.tagName.toLowerCase()}${control.getAttribute('role') ? `[role=${control.getAttribute('role')}]` : ''} "${label.trim().slice(0, 50)}"`
          if (seen.has(control)) {
            resolve({ name, kind: 'repeat', covered: 0 })
            return
          }
          seen.add(control)
          const bar = document.querySelector('[data-sticky-actions]')
          if (!bar) {
            resolve({ name, kind: 'checked', covered: 0 })
            return
          }
          if (bar.contains(control)) {
            resolve({ name, kind: 'bar', covered: 0 })
            return
          }
          if (control.getAttribute('role') === 'tabpanel') {
            resolve({ name, kind: 'panel', covered: 0 })
            return
          }
          // A visually hidden control (a segmented choice's radio) shows its focus on its label.
          const own = control.getBoundingClientRect()
          const shown = own.width > 1 && own.height > 1 ? control : (control.closest('label') ?? control)
          const box = shown.getBoundingClientRect()
          const barBox = bar.getBoundingClientRect()
          const ring = 4
          const across = Math.min(box.right + ring, barBox.right) - Math.max(box.left - ring, barBox.left)
          const covered = Math.min(box.bottom + ring, barBox.bottom) - Math.max(box.top - ring, barBox.top)
          resolve({ name, kind: 'checked', covered: across > 0 && covered > 0 ? Math.round(covered * 10) / 10 : 0 })
        })
      }),
  )
}

const BAR_PAGES: FocusPage[] = [
  { label: 'company settings', account: 'admin', path: '/admin/settings', ready: (page) => page.getByRole('textbox', { name: 'Company name' }) },
  { label: 'walk-in', account: 'reception', path: '/reception?tab=walk-in', ready: (page) => page.getByRole('button', { name: 'Check in walk-in' }) },
]

const WALK_SIZES = [
  { width: 320, height: 720 },
  { width: 390, height: 700 },
]

for (const check of BAR_PAGES) {
  test.describe(check.label, () => {
    test.use({ storageState: storageStatePath(check.account) })
    for (const size of WALK_SIZES) {
      test(`${check.label} at ${size.width} × ${size.height}: Tab never leaves focus under the sticky action bar (F9-4, F9-8)`, async ({ page }, testInfo) => {
        await page.setViewportSize(size)
        await load(page, check)
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())

        const stops: Stop[] = []
        for (let presses = 0; presses < 150; presses += 1) {
          await page.keyboard.press('Tab')
          const stop = await measureStop(page)
          if (stop.kind === 'end' || stop.kind === 'repeat') break
          stops.push(stop)
        }
        const checked = stops.filter((stop) => stop.kind === 'checked')
        testInfo.annotations.push({ type: 'tab walk', description: `${check.path} at ${size.width}×${size.height}: ${checked.length} stops checked, ${stops.length - checked.length} in the bar or the tab panel` })
        expect(checked.length, 'focus stops checked').toBeGreaterThanOrEqual(5)
        expect(stops.some((stop) => stop.kind === 'bar'), 'the walk reached the action bar').toBe(true)
        expect(
          checked.filter((stop) => stop.covered > 0).map((stop) => `${stop.name}: ${stop.covered} px under the bar`),
          'focused controls (ring included) under the sticky action bar',
        ).toEqual([])
      })
    }
  })
}
