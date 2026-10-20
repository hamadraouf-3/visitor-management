import { AxeBuilder } from '@axe-core/playwright'
import { readFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import type { Language } from '../src/i18n/languages.ts'
import type { Visit } from '../src/types/api.ts'
import { meOf, mockCompanyApi, mockVisit, type MockCompany } from './support/mock-company.ts'
import { lineProblems } from './support/icalendar.ts'
import { horizontalOverflow } from './support/ui.ts'

/*
 * "Add to my calendar" on the visit page (Phase 14, F14-1), at the project's viewport, in both
 * languages and both colour schemes: the kit's menu button at the end of the schedule (a row of its own
 * on phones), opened and left from the keyboard, its popup inside the screen, named for a screen reader
 * (the two links say they open a new tab), no serious axe finding with it open, no sideways scroll; the
 * file it saves is a valid iCalendar object in the UI's language. The menu is written from the visit as
 * it is when it opens (the trigger busy meanwhile): a new time made since is in its links and its file,
 * and a visit cancelled since opens nothing. The API is mocked: Vite only.
 */

const COMPANY: MockCompany = { slug: 'cedar', name: 'Cedar Holdings', name_ar: 'سيدار القابضة', colour: '#1d8387' }
const ADDRESS = { address: 'Building 14, King Abdullah II Street\nAmman 11953, Jordan', address_ar: 'مبنى رقم 14، شارع الملك عبدالله الثاني\nعمّان 11953، الأردن' }
const VISIT: Visit = {
  ...mockVisit(7, 'Mariam Haddad', 'Cedar Advisory', 'SCHEDULED', 26 * 60),
  purpose: 'Annual compliance review with the finance team',
  calendar_sequence: 1,
  invitation: { status: 'SENT', to_email: 'mariam.haddad@guest.test', attempts: 1, last_attempt_at: null, sent_at: null, error: null, calendar_failed: false },
}

const WORDS = {
  en: { menu: 'Add to my calendar', items: ['Google Calendar', 'Outlook', 'Apple and others (.ics)'], newTab: '(opens in a new tab)', summary: 'SUMMARY:Visit: Mariam Haddad' },
  ar: { menu: 'أضف إلى تقويمي', items: ['تقويم Google', 'Outlook', 'تقويم Apple وغيره (ملف ics)'], newTab: '(يُفتح في علامة تبويب جديدة)', summary: 'SUMMARY:زيارة: Mariam Haddad' },
} as const

/**
 * The visit page. Returns `change`: from then on, every request for the visit (the menu's, fetching it
 * again) finds it changed elsewhere, answered after `delayMs`.
 */
async function openVisit(page: Page, language: Language, scheme: 'light' | 'dark', { delayMs = 0 }: { delayMs?: number } = {}) {
  await page.emulateMedia({ colorScheme: scheme })
  let later: Visit | null = null
  await mockCompanyApi(page, {
    company: COMPANY,
    signedIn: language,
    extra: (path, route) => {
      if (path === '/auth/me') {
        const me = meOf(COMPANY, language)
        return route.fulfill({ json: { ...me, company: { ...me.company, ...ADDRESS } } })
      }
      if (path === `/visits/${VISIT.id}`) {
        const answer = later
        if (!answer) return route.fulfill({ json: VISIT })
        return new Promise((resolve) => setTimeout(resolve, delayMs)).then(() => route.fulfill({ json: answer }))
      }
      return undefined
    },
  })
  await page.goto(`/visits/${VISIT.id}`)
  await expect(page.getByRole('heading', { level: 1, name: 'Mariam Haddad' })).toBeVisible({ timeout: 30_000 })
  return {
    change: (visit: Visit) => {
      later = visit
    },
  }
}

for (const language of ['en', 'ar'] as const) {
  for (const scheme of ['light', 'dark'] as const) {
    test(`the host’s calendar menu in ${language}, ${scheme}: in reach, named, inside the screen, axe-clean`, async ({ page }) => {
      const words = WORDS[language]
      await openVisit(page, language, scheme)
      const width = page.viewportSize()!.width
      const trigger = page.getByRole('button', { name: words.menu })
      await expect(trigger).toBeVisible()
      const strip = trigger.locator('xpath=ancestor::div[contains(@class, "bg-surface-sunken")][1]')
      const [button, around] = [(await trigger.boundingBox())!, (await strip.boundingBox())!]
      if (width < 640) {
        // Phones: a row of its own under the time, as wide as the strip's content.
        expect(button.width).toBeGreaterThan(around.width - 40)
      } else {
        // The end of the schedule's strip: on the right in English, on the left in Arabic.
        const atEnd = language === 'ar' ? button.x - around.x : around.x + around.width - (button.x + button.width)
        expect(atEnd).toBeLessThan(24)
      }
      expect(button.height).toBeGreaterThanOrEqual(44)

      // The keyboard opens it on its first item; the popup stays on the screen.
      await trigger.focus()
      await page.keyboard.press('Enter')
      const menu = page.getByRole('menu', { name: words.menu })
      await expect(menu).toBeVisible()
      const items = menu.getByRole('menuitem')
      await expect(items).toHaveText([...words.items])
      await expect(items.first()).toBeFocused()
      await expect(items.nth(0)).toHaveAccessibleName(`${words.items[0]} ${words.newTab}`)
      await expect(items.nth(1)).toHaveAccessibleName(`${words.items[1]} ${words.newTab}`)
      await expect(items.nth(2)).toHaveAccessibleName(words.items[2])
      const popup = (await menu.boundingBox())!
      expect(popup.x).toBeGreaterThanOrEqual(0)
      expect(popup.x + popup.width).toBeLessThanOrEqual(width)
      for (const box of await Promise.all((await items.all()).map((item) => item.boundingBox()))) expect(box!.height).toBeGreaterThanOrEqual(40)

      const results = await new AxeBuilder({ page }).analyze()
      const blocking = results.violations.filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
      expect(blocking.map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`)).toEqual([])
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0)

      await page.keyboard.press('ArrowUp')
      await expect(items.last()).toBeFocused()
      await page.keyboard.press('Escape')
      await expect(menu).toBeHidden()
      await expect(trigger).toBeFocused()
    })
  }

  test(`the file it saves in ${language}: a valid iCalendar object of the host’s event`, async ({ page }) => {
    const words = WORDS[language]
    await openVisit(page, language, 'light')
    await page.getByRole('button', { name: words.menu }).click()
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: words.items[2] }).click()])
    expect(download.suggestedFilename()).toMatch(/^visit-\d{4}-\d{2}-\d{2}\.ics$/)
    const bytes = readFileSync(await download.path())
    expect(lineProblems(bytes)).toEqual([])
    const text = bytes.toString('utf8')
    const unfolded = text.replace(/\r\n /g, '')
    expect(unfolded).toContain(`\r\nUID:visit-${VISIT.id}-host\r\nSEQUENCE:1\r\n`)
    expect(unfolded).toContain(`\r\n${words.summary}\r\n`)
    // Private, as the e-mailed host event (B14-19, F14-29).
    expect(unfolded).toContain('\r\nCLASS:PRIVATE\r\nSTATUS:CONFIRMED\r\n')
    expect(unfolded).not.toMatch(/METHOD|ORGANIZER|ATTENDEE/)
  })
}

test('the menu is written from the visit as it is when it opens: busy while it is fetched, then a new time made since', async ({ page }) => {
  const moved: Visit = { ...VISIT, calendar_sequence: 2, scheduled_start: '2031-03-04T11:30:00Z', scheduled_end: '2031-03-04T12:15:00Z', updated_at: '2031-03-01T08:00:00Z' }
  const { change } = await openVisit(page, 'en', 'light', { delayMs: 800 })
  const trigger = page.getByRole('button', { name: WORDS.en.menu })
  await expect(trigger).toBeVisible()
  change(moved)

  await trigger.click()
  // The kit's loading state: busy, unavailable, the spinner in place of the icon.
  await expect(trigger).toHaveAttribute('aria-busy', 'true')
  await expect(trigger).toHaveAttribute('aria-disabled', 'true')
  await expect(trigger.locator('.animate-spin')).toHaveCount(1)
  const menu = page.getByRole('menu', { name: WORDS.en.menu })
  await expect(menu).toBeVisible()
  await expect(trigger).not.toHaveAttribute('aria-busy')
  await expect(menu.getByRole('menuitem').first()).toBeFocused()

  const google = new URL((await menu.getByRole('menuitem', { name: `${WORDS.en.items[0]} ${WORDS.en.newTab}` }).getAttribute('href'))!)
  expect(google.searchParams.get('dates')).toBe('20310304T113000Z/20310304T121500Z')
  const outlook = new URL((await menu.getByRole('menuitem', { name: `${WORDS.en.items[1]} ${WORDS.en.newTab}` }).getAttribute('href'))!)
  expect([outlook.searchParams.get('startdt'), outlook.searchParams.get('enddt')]).toEqual(['2031-03-04T11:30:00Z', '2031-03-04T12:15:00Z'])
  const [download] = await Promise.all([page.waitForEvent('download'), menu.getByRole('menuitem', { name: WORDS.en.items[2] }).click()])
  expect(download.suggestedFilename()).toBe('visit-2031-03-04.ics')
  const unfolded = readFileSync(await download.path(), 'utf8').replace(/\r\n /g, '')
  expect(unfolded).toContain(`\r\nUID:visit-${VISIT.id}-host\r\nSEQUENCE:2\r\nDTSTAMP:20310301T080000Z\r\nDTSTART:20310304T113000Z\r\nDTEND:20310304T121500Z\r\n`)
})

test('a visit cancelled since the page loaded: the menu opens nothing, the page shows the cancellation, the focus goes on from its heading', async ({ page }) => {
  const cancelled: Visit = { ...VISIT, status: 'CANCELLED', cancelled_at: VISIT.created_at, calendar_sequence: 2 }
  const { change } = await openVisit(page, 'en', 'light')
  const trigger = page.getByRole('button', { name: WORDS.en.menu })
  await expect(trigger).toBeVisible()
  change(cancelled)

  await trigger.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByText('This visit was cancelled')).toBeVisible()
  await expect(trigger).toHaveCount(0)
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(page.getByRole('heading', { level: 1, name: 'Mariam Haddad' })).toBeFocused()
})

/** The badge words a visible chip cuts (its text wider than its box), by their text. */
async function cutChips(page: Page, label: string): Promise<{ text: string | null; cut: number }[]> {
  const spans = page.locator('span.truncate').filter({ hasText: label }).filter({ visible: true })
  await expect(spans.first()).toBeVisible()
  return spans.evaluateAll((elements) => elements.map((element) => ({ text: element.textContent, cut: element.scrollWidth - element.clientWidth })))
}

test('a calendar invitation that did not arrive, in the Needs attention list at 1280 and 1440 px: its chip whole in both languages (F14-27)', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'the widths are set here; once is enough')
  const calendarFailed: Visit = {
    ...mockVisit(21, 'Sara Ahmad', 'Orbit Labs', 'SCHEDULED', 26 * 60),
    invitation: { status: 'FAILED', to_email: 'sara.ahmad@guest.test', attempts: 2, last_attempt_at: VISIT.created_at, sent_at: null, error: 'Mailbox full', calendar_failed: true },
  }
  const words = { en: 'Calendar failed', ar: 'لم يصل التقويم' } as const
  for (const language of ['en', 'ar'] as const) {
    await page.unrouteAll({ behavior: 'ignoreErrors' })
    await mockCompanyApi(page, {
      company: COMPANY,
      signedIn: language,
      extra: (path, route) => {
        if (path === '/visits') return route.fulfill({ json: { items: [calendarFailed], page: 1, page_size: 25, total: 1 } })
        return undefined
      },
    })
    for (const width of [1440, 1280]) {
      await page.setViewportSize({ width, height: 900 })
      await page.goto('/visits?tab=attention')
      const chips = await cutChips(page, words[language])
      expect(chips.length, `${language} ${width}px`).toBeGreaterThan(0)
      for (const chip of chips) expect(chip.cut, `${language} ${width}px: "${chip.text}" cut`).toBeLessThanOrEqual(0)
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0)
    }
  }
})

test('the invitation’s outcome row wraps at 640–720 px with the text at 20 px: no button past the screen (F14-21)', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'the width is set here; once is enough')
  const invited: Visit = { ...VISIT, invitation: { ...VISIT.invitation, status: 'SENT' } }
  await mockCompanyApi(page, {
    company: COMPANY,
    signedIn: 'en',
    extra: (path, route) => {
      const me = meOf(COMPANY, 'en', {}, ['EMPLOYEE'])
      if (path === '/auth/me') return route.fulfill({ json: me })
      if (path === '/departments') return route.fulfill({ json: [] })
      if (path === '/users/hosts') return route.fulfill({ json: [{ id: me.user.id, full_name: me.user.full_name, phone: null, department: me.user.department }] })
      if (path === '/visits' && route.request().method() === 'POST') {
        return route.fulfill({ status: 201, json: { visit: invited, pass_url: 'https://visitors.example.test/pass?c=cedar#token', visitor_match: { reused: false } } })
      }
      if (path === `/visits/${VISIT.id}`) return route.fulfill({ json: invited })
      return undefined
    },
  })
  for (const width of [640, 680, 720]) {
    await page.setViewportSize({ width, height: 900 })
    await page.goto('/visits/new')
    await page.addStyleTag({ content: 'html { font-size: 20px !important; }' })
    await page.getByRole('textbox', { name: 'Full name' }).fill('Mariam Haddad', { timeout: 30_000 })
    await page.getByRole('textbox', { name: /^Email/ }).fill('mariam.haddad@guest.test')
    await page.getByRole('textbox', { name: /^Purpose/ }).fill('Annual compliance review')
    await page.getByRole('button', { name: 'Send invitation' }).click()
    const trigger = page.getByRole('button', { name: 'Add to my calendar' })
    await expect(trigger).toBeVisible()
    const row = trigger.locator('xpath=ancestor::div[contains(@class, "sm:flex-wrap")][1]')
    const outside = await row.evaluate((element) => {
      const box = element.getBoundingClientRect()
      return [...element.querySelectorAll('a, button')]
        .map((child) => child.getBoundingClientRect())
        .filter((child) => child.left < box.left - 1 || child.right > box.right + 1).length
    })
    expect(outside, `${width}px: buttons outside the row`).toBe(0)
    expect(await horizontalOverflow(page), `${width}px`).toBeLessThanOrEqual(0)
  }
})
