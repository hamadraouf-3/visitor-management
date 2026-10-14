import type { Locator, Page } from '@playwright/test'
import { expect, test } from '../support/fixtures.ts'
import { qualityData } from '../support/quality-data.ts'
import { afterFrames, horizontalOverflow, strongPassword, uniqueTag } from '../support/ui.ts'

/*
 * Reflow in Arabic on small phones (WCAG 1.4.10; phase 10 review). The accessibility spec checks
 * every page at 320 px in English only, by the page's horizontal scroll. Two things it cannot see in
 * Arabic: labels are longer («التحقق من الهوية وتسجيل الدخول» is 314 px against "Verify ID & check in"'s
 * 254 px, which overflowed the Expected row's card at 360 px and the screen at 320 px), and content
 * that overflows to the left in a right-to-left page creates no scrollable overflow at all. So each
 * page is checked at 360 and 320 px for every visible control: inside the viewport, and inside the
 * nearest card (bordered box) around it. Controls in a horizontally scrolling strip are left out, as
 * are visually hidden ones.
 *
 * The user is one of its own (never a seeded account, whose language every other spec relies on),
 * with the reception and employee roles and Arabic as its language; the pages show the run's quality
 * data (an expected visitor, visitors inside). Phone project only (touch, the phones' layout).
 */

test.describe.configure({ mode: 'serial' })

interface Escape {
  control: string
  box: { left: number; right: number }
  container: { left: number; right: number } | null
}

/** Visible controls that stick out of the viewport or out of the card around them. */
function escapingControls(page: Page): Promise<Escape[]> {
  return page.evaluate(() => {
    const width = document.documentElement.clientWidth
    const controls = document.querySelectorAll<HTMLElement>('main button, main a[href], main input, main select, main textarea, main [role="tab"], main [role="combobox"]')
    // Runs in the page: its helpers must live inside this one function (they are not serialised with it).
    // oxlint-disable-next-line unicorn/consistent-function-scoping
    const scrollsSideways = (element: Element) => {
      for (let node = element.parentElement; node; node = node.parentElement) {
        const overflow = getComputedStyle(node).overflowX
        if ((overflow === 'auto' || overflow === 'scroll') && node.scrollWidth > node.clientWidth + 1) return true
      }
      return false
    }
    // oxlint-disable-next-line unicorn/consistent-function-scoping
    const card = (element: Element): HTMLElement | null => {
      for (let node = element.parentElement; node && node !== document.body; node = node.parentElement) {
        const style = getComputedStyle(node)
        if (style.display.startsWith('inline')) continue
        if (Number.parseFloat(style.borderInlineStartWidth) > 0 && Number.parseFloat(style.borderInlineEndWidth) > 0) return node
      }
      return null
    }
    const escapes: Escape[] = []
    for (const control of controls) {
      const rect = control.getBoundingClientRect()
      const style = getComputedStyle(control)
      if (rect.width <= 1 || rect.height <= 1 || style.visibility === 'hidden' || style.clipPath !== 'none' || style.clip !== 'auto') continue
      if (control.closest('[aria-hidden="true"], [hidden]')) continue
      if (scrollsSideways(control)) continue
      const box = { left: rect.left, right: rect.right }
      const name = `${control.tagName.toLowerCase()} "${(control.getAttribute('aria-label') ?? control.textContent ?? '').trim().slice(0, 40)}"`
      if (box.left < -1 || box.right > width + 1) {
        escapes.push({ control: name, box, container: { left: 0, right: width } })
        continue
      }
      const around = card(control)
      if (!around) continue
      const outer = around.getBoundingClientRect()
      if (box.left < outer.left - 1 || box.right > outer.right + 1) escapes.push({ control: name, box, container: { left: outer.left, right: outer.right } })
    }
    return escapes
  })
}

/** The options of My visits' status choice that do not fit the select's text area (its own font). */
function cutOptions(page: Page): Promise<{ option: string; needs: number; room: number }[]> {
  return page.getByRole('combobox', { name: /^(Show|عرض)$/ }).evaluate((select: HTMLSelectElement) => {
    const style = getComputedStyle(select)
    const context = document.createElement('canvas').getContext('2d')!
    context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
    const room = select.clientWidth - Number.parseFloat(style.paddingInlineStart) - Number.parseFloat(style.paddingInlineEnd)
    return [...select.options]
      .map((option) => ({ option: option.text, needs: Math.ceil(context.measureText(option.text).width), room: Math.floor(room) }))
      .filter((entry) => entry.needs > entry.room)
  })
}

const MY_VISITS_TABS = ['', '?tab=upcoming', '?tab=past']

interface ArabicPage {
  name: string
  path: string
  ready: (page: Page) => Locator
}

const PAGES: ArabicPage[] = [
  { name: 'reception: expected', path: '/reception?tab=expected', ready: (page) => page.getByText('Sara Khoury').first() },
  { name: 'reception: inside', path: '/reception?tab=inside', ready: (page) => page.getByRole('list', { name: 'الزوار داخل المبنى' }) },
  { name: 'reception: walk-in', path: '/reception?tab=walk-in', ready: (page) => page.getByRole('button', { name: 'تسجيل دخول الزائر' }) },
  { name: 'reception: scan', path: '/reception', ready: (page) => page.getByText('جاهز للمسح') },
  { name: 'my visits', path: '/visits', ready: (page) => page.getByRole('heading', { level: 1, name: 'زياراتي' }) },
  { name: 'visit history', path: '/history', ready: (page) => page.getByText('Karim Nasser').first() },
  { name: 'inside now', path: '/inside', ready: (page) => page.getByText('Karim Nasser').first() },
  { name: 'visitors', path: '/visitors', ready: (page) => page.getByRole('heading', { level: 1, name: 'الزوار' }) },
]

test('Arabic pages reflow at 360 and 320 px: no control outside the screen or its card (phase 10 review)', async ({ apiAs, open }) => {
  test.skip(test.info().project.name !== 'mobile', 'Phone widths, with touch: the phone project')
  test.setTimeout(240_000)
  qualityData() // the run's data must exist (global setup)
  const tag = uniqueTag()
  const email = `rana.reflow.${tag}@demo.local`
  const temporary = strongPassword()
  const password = strongPassword()
  const admin = await apiAs('admin')
  await admin.ok('POST', '/users', { full_name: `Rana Saleh ${tag}`, email, roles: ['RECEPTIONIST', 'EMPLOYEE'], temporary_password: temporary })

  const { page, context, api } = await open()
  const signedIn = await context.request.post('/api/v1/auth/login', { data: { email, password: temporary } })
  expect(signedIn.ok(), await signedIn.text()).toBe(true)
  await api.ok('POST', '/auth/change-password', { current_password: temporary, new_password: password })
  await api.ok('PATCH', '/auth/preferences', { language: 'ar' })

  const problems: string[] = []
  for (const check of PAGES) {
    for (const width of [360, 320]) {
      await page.setViewportSize({ width, height: 800 })
      await page.goto(check.path)
      await expect(page.locator('html')).toHaveAttribute('dir', 'rtl')
      await expect(check.ready(page)).toBeVisible()
      await expect(page.locator('[role="status"] .animate-spin')).toHaveCount(0)
      await page.waitForLoadState('networkidle')
      await afterFrames(page, 2)
      const overflow = await horizontalOverflow(page)
      if (overflow > 0) problems.push(`${check.name} at ${width} px: the page scrolls sideways by ${overflow} px`)
      for (const escape of await escapingControls(page)) {
        problems.push(`${check.name} at ${width} px: ${escape.control} spans ${Math.round(escape.box.left)}..${Math.round(escape.box.right)}, outside ${Math.round(escape.container!.left)}..${Math.round(escape.container!.right)}`)
      }
    }
  }
  expect(problems).toEqual([])

  // The Expected row's action, the review's case: wraps inside its card instead of overflowing it.
  await page.setViewportSize({ width: 360, height: 800 })
  await page.goto('/reception?tab=expected')
  const action = page.getByRole('listitem').filter({ hasText: 'Sara Khoury' }).getByRole('button', { name: 'التحقق من الهوية وتسجيل الدخول' })
  await expect(action).toBeVisible()
  const [button, row] = await Promise.all([action.boundingBox(), page.getByRole('listitem').filter({ hasText: 'Sara Khoury' }).boundingBox()])
  expect(button!.x).toBeGreaterThanOrEqual(row!.x)
  expect(button!.x + button!.width).toBeLessThanOrEqual(row!.x + row!.width + 0.5)

  // My visits' status choice shows its whole current option («الكل عدا الملغاة» was cut at 390 px).
  for (const width of [390, 360, 320]) {
    await page.setViewportSize({ width, height: 800 })
    for (const tab of MY_VISITS_TABS) {
      await page.goto(`/visits${tab}`)
      await expect(page.getByRole('heading', { level: 1, name: 'زياراتي' })).toBeVisible()
      expect(await cutOptions(page), `options cut off at ${width} px on /visits${tab}`).toEqual([])
    }
  }
})

test('My visits in English: the status choice shows its whole current option on a phone (phase 10 review)', async ({ open }) => {
  test.skip(test.info().project.name !== 'mobile', 'Phone widths, with touch: the phone project')
  // "All but cancelled" was cut at 390 px. The seeded employee is only read (English, as every spec).
  const { page } = await open({ as: 'employee' })
  for (const width of [390, 360, 320]) {
    await page.setViewportSize({ width, height: 800 })
    for (const tab of MY_VISITS_TABS) {
      await page.goto(`/visits${tab}`)
      await expect(page.getByRole('heading', { level: 1, name: 'My visits' })).toBeVisible()
      expect(await cutOptions(page), `options cut off at ${width} px on /visits${tab}`).toEqual([])
    }
  }
})
