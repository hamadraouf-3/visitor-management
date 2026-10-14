import { expect, test, type Page } from '@playwright/test'
import type { EmailPreview, EmailTemplate, InsideList, ReceptionToday } from '../src/types/api.ts'
import { MOCK_VISITS, mockCompanyApi, type MockCompany } from './support/mock-company.ts'
import { measureTouchTargets, tooSmall } from './support/touch-targets.ts'

/*
 * Touch targets on a company's pages, on a touch screen (the UX review of Phase 12, finding 13). The
 * review listed four older patterns as under 44 px by the size of their boxes: a row's name link
 * (20 px), the back link (24 px), the reception's checkbox (24 px), the variable chips of the e-mail
 * texts (28 px). Hit-tested here with a coarse pointer, the way a tap lands (support/touch-targets.ts):
 *
 * - a name link's hit area is its whole card, and the back link and the chips are 44 px tall on a
 *   touch screen (`pointer-coarse:`): three of the four were never under 44 px for a finger;
 * - the checkbox was: its box was a 24 px target of its own, with 12 px of nothing between it and its
 *   words. The box, the gap and the words are one target now, 44 px tall on a touch screen.
 *
 * Every control of these pages is measured, so the next one that falls short fails here. The API is
 * mocked; this spec needs only the Vite server. It runs in the phone and tablet projects (touch).
 */

const COMPANY: MockCompany = { slug: 'demo-holdings', name: 'Demo Holdings', name_ar: null, colour: null }

const text = (name: EmailTemplate['fields'][number]['name'], multiline: boolean, max: number, ar: string, en: string, required: string[] = []): EmailTemplate['fields'][number] => ({
  name,
  multiline,
  max_length: max,
  required_variables: required,
  forbidden_variables: name === 'subject' ? ['purpose'] : [],
  default: { ar, en },
  override: { ar: null, en: null },
})

const TEMPLATE: EmailTemplate = {
  kind: 'VISITOR_INVITATION',
  variables: ['visitor_name', 'company', 'host_name', 'date', 'time', 'timezone', 'department', 'purpose'],
  max_variable_uses: 3,
  updated_at: null,
  fields: [text('subject', false, 150, 'زيارتك إلى {company}', 'Your visit to {company}', ['company']), text('heading', false, 150, 'زيارتك إلى {company}', 'Your visit to {company}'), text('intro', true, 1000, 'دعوة', 'Invitation')],
}

const PREVIEW: EmailPreview = { kind: 'VISITOR_INVITATION', language: 'en', subject: 'Your visit to Demo Holdings', html: '<!DOCTYPE html><html></html>', text: 'Demo Holdings\n====\n\nYour visit to Demo Holdings\n\n--\nSent by Demo Holdings.' }

const TODAY: ReceptionToday = {
  date: new Date().toISOString().slice(0, 10),
  counts: { expected: 2, inside: 1, checked_out: 0, no_show: 0, cancelled: 0, walk_ins: 0 },
  expected: MOCK_VISITS.slice(1),
  inside: MOCK_VISITS.slice(0, 1),
  checked_out: [],
  no_show: [],
}

const INSIDE: InsideList = { count: 1, items: MOCK_VISITS.slice(0, 1).map((visit) => ({ ...visit, visitor: { ...visit.visitor, phone: '+962 7 7000 1122' } })) }

async function mock(page: Page) {
  await mockCompanyApi(page, {
    company: COMPANY,
    signedIn: 'en',
    extra: (path, route) => {
      if (/^\/visits\/[0-9a-f-]+$/.test(path)) return route.fulfill({ json: MOCK_VISITS[1] })
      if (path === '/reception/today') return route.fulfill({ json: TODAY })
      if (path === '/reception/inside') return route.fulfill({ json: INSIDE })
      if (path === '/email-templates/VISITOR_INVITATION') return route.fulfill({ json: TEMPLATE })
      if (path === '/email-templates/VISITOR_INVITATION/preview') return route.fulfill({ json: PREVIEW })
      return undefined
    },
  })
}

const PAGES = [
  ['My visits', '/visits'],
  ['Invite visitor', '/visits/new'],
  ['a visit', `/visits/${MOCK_VISITS[1]!.id}`],
  ['Reception', '/reception'],
  ['Inside now', '/inside'],
  ['an e-mail’s texts', '/admin/email-templates/VISITOR_INVITATION'],
] as const

test('every control of a company’s pages can be tapped: none is reached over less than 44 px', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'desktop', 'Needs a touch screen')
  await mock(page)
  for (const [name, address] of PAGES) {
    await test.step(name, async () => {
      await page.goto(address)
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 30_000 })
      await page.waitForLoadState('networkidle')
      expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches), 'touch screen').toBe(true)
      const targets = await measureTouchTargets(page)
      expect(targets.length, `${name}: controls measured`).toBeGreaterThan(5)
      expect(tooSmall(targets), `${name}: controls a finger cannot use`).toEqual([])
    })
  }
})

test('the four patterns of the review, as a tap reaches them', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'desktop', 'Needs a touch screen')
  await mock(page)
  const reachOf = async (words: string | RegExp) => {
    const found = (await measureTouchTargets(page)).filter((target) => (typeof words === 'string' ? target.what.includes(words) : words.test(target.what)))
    expect(found.length, `controls named ${String(words)}`).toBeGreaterThan(0)
    return found
  }

  // A row's name link: 20 px of text, and the whole card as its hit area.
  await page.goto('/visits')
  await expect(page.getByRole('heading', { level: 1, name: 'My visits' })).toBeVisible({ timeout: 30_000 })
  await expect(page.getByRole('link', { name: 'Khalid Mansour' }).first()).toBeVisible()
  for (const target of await reachOf('Khalid Mansour')) {
    expect(target.box.height, 'the name’s own box').toBeLessThan(44)
    expect(target.reach.height, target.what).toBeGreaterThanOrEqual(44)
    expect(target.reach.width, target.what).toBeGreaterThanOrEqual(44)
  }

  // The back link above a page's title.
  await page.goto(`/visits/${MOCK_VISITS[1]!.id}`)
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  const [back] = await reachOf('Back to My visits')
  expect(back!.reach.height).toBeGreaterThanOrEqual(44)
  expect(back!.box.height, 'its own box on a touch screen').toBeGreaterThanOrEqual(44)

  // The variable chips under an e-mail's text.
  await page.goto('/admin/email-templates/VISITOR_INVITATION')
  await expect(page.locator('[data-template-field="en.subject"]')).toBeVisible()
  const chips = await page.locator('[data-template-field="en.subject"]').getByRole('toolbar').locator('button').evaluateAll((buttons) => buttons.map((button) => Math.round(button.getBoundingClientRect().height)))
  expect(chips.length).toBeGreaterThan(3)
  expect(Math.min(...chips)).toBeGreaterThanOrEqual(44)

  // The reception's checkbox: the box, the gap beside it and its words are one target.
  await page.goto('/reception')
  const beep = page.getByRole('checkbox', { name: 'Beep on check-in and check-out' })
  await expect(beep).toBeVisible()
  const [box] = await reachOf('Beep on check-in and check-out')
  expect(box!.box, 'the box itself').toEqual({ width: 24, height: 24 })
  expect(box!.reach.height).toBeGreaterThanOrEqual(44)
  expect(box!.reach.width).toBeGreaterThanOrEqual(150)
  // A tap in the gap between the box and its words, and one just under the box, tick it (they did nothing).
  const row = page.locator('[data-checkbox-row]')
  const [rowBox, inputBox] = [await row.boundingBox(), await beep.boundingBox()]
  const rtl = await page.evaluate(() => document.documentElement.dir === 'rtl')
  const before = await beep.isChecked()
  await page.touchscreen.tap(rtl ? inputBox!.x - 6 : inputBox!.x + inputBox!.width + 6, inputBox!.y + inputBox!.height / 2)
  await expect(beep).toBeChecked({ checked: !before })
  await page.touchscreen.tap(inputBox!.x + inputBox!.width / 2, Math.min(rowBox!.y + rowBox!.height - 2, inputBox!.y + inputBox!.height + 7))
  await expect(beep).toBeChecked({ checked: before })
})
