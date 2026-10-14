import { AxeBuilder } from '@axe-core/playwright'
import type { Locator, Page } from '@playwright/test'
import type { Visit } from '../../src/types/api.ts'
import { passToken, type Api } from '../support/api.ts'
import { timeTravel } from '../support/cli.ts'
import { FAIL_DOMAIN } from '../support/env.ts'
import { expect, test } from '../support/fixtures.ts'
import { localDate, minutes } from '../support/time.ts'
import { followNavLink, scanPass, scanResult, uniqueTag } from '../support/ui.ts'

/*
 * Every dialog of the app, opened in its real state at 1440 × 900 and 820 × 1180 (the desktop and
 * tablet projects; playwright.config.ts leaves this file out of the phone project): the panel lies
 * inside the viewport, every footer button lies inside the panel (gate hand-over of
 * phase-5-7-frontend-employee.md #49), the header is balanced (phase 10 review: a title-only header
 * had 16 px above the title and 36 px below it, the close icon 10 px lower than the title: the title
 * block has the same space above and below, the close button's centre level with the title's first
 * line), and the open dialog has no serious or critical axe violation. Dialogs are closed with Escape (nothing is changed) except where opening the next one
 * needs the action. The data lives in Other Corp, so no Demo Company scenario sees it.
 */

test.describe.configure({ mode: 'parallel' })

/** A modal by its accessible name, whether it is a `dialog` or an `alertdialog`. */
function modal(page: Page, name: string): Locator {
  return page.getByRole('dialog', { name, exact: true }).or(page.getByRole('alertdialog', { name, exact: true }))
}

interface Box {
  x: number
  y: number
  width: number
  height: number
}

const inside = (inner: Box, outer: Box) =>
  inner.x >= outer.x - 0.5 &&
  inner.y >= outer.y - 0.5 &&
  inner.x + inner.width <= outer.x + outer.width + 0.5 &&
  inner.y + inner.height <= outer.y + outer.height + 0.5

interface Geometry {
  viewport: Box
  panel: Box
  buttons: { label: string; box: Box }[]
  /** Space above and below the header's text block, and the close button's centre less the title's first line's. */
  header: { above: number; below: number; closeOffset: number | null }
}

/** The panel and its footer buttons, measured in one go. */
function measure(dialog: Locator): Promise<Geometry> {
  // Runs in the page: one function, no helpers (they would not be serialised with it).
  return dialog.evaluate((panel) => {
    const [panelBox, ...buttons] = [panel, ...panel.querySelectorAll(':scope > footer button')].map((element) => {
      const rect = element.getBoundingClientRect()
      return { label: element === panel ? '' : (element.textContent?.trim() ?? ''), box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } }
    })
    const header = panel.querySelector(':scope > header') as HTMLElement
    const text = header.firstElementChild as HTMLElement
    const title = header.querySelector('h2') as HTMLElement
    const close = header.querySelector('[data-dialog-close]')
    const headerRect = header.getBoundingClientRect()
    const textRect = text.getBoundingClientRect()
    const titleRect = title.getBoundingClientRect()
    const firstLineCentre = titleRect.top + Number.parseFloat(getComputedStyle(title).lineHeight) / 2
    const bottom = headerRect.bottom - Number.parseFloat(getComputedStyle(header).borderBottomWidth)
    const closeRect = close?.getBoundingClientRect()
    return {
      viewport: { x: 0, y: 0, width: document.documentElement.clientWidth, height: window.innerHeight },
      panel: panelBox!.box,
      buttons,
      header: {
        above: textRect.top - headerRect.top,
        below: bottom - textRect.bottom,
        closeOffset: closeRect ? closeRect.top + closeRect.height / 2 - firstLineCentre : null,
      },
    }
  })
}

/**
 * The geometry once the dialog has settled: content that loads after opening (a lazily rendered QR
 * code, a list) resizes the panel, so it is measured until two readings 150 ms apart agree.
 */
async function settledGeometry(dialog: Locator): Promise<Geometry> {
  await expect(dialog.locator('[role="status"] .animate-spin')).toHaveCount(0)
  let previous = await measure(dialog)
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 150))
    const current = await measure(dialog)
    if (JSON.stringify(current) === JSON.stringify(previous)) return current
    previous = current
  }
  throw new Error('The dialog kept changing size for 3 s')
}

/** Checks an open dialog; closes it with Escape unless `keepOpen`. */
async function checkDialog(page: Page, dialog: Locator, options: { footer?: boolean; keepOpen?: boolean } = {}): Promise<void> {
  const { footer = true, keepOpen = false } = options
  await expect(dialog).toBeVisible()
  const name = (await dialog.getAttribute('aria-labelledby')) ?? 'dialog'
  const { viewport, panel, buttons, header } = await settledGeometry(dialog)
  expect(inside(panel, viewport), `dialog panel ${JSON.stringify(panel)} inside the ${viewport.width} × ${viewport.height} viewport`).toBe(true)
  expect(Math.abs(header.above - header.below), `header: ${JSON.stringify(header)} (space above and below the title block)`).toBeLessThanOrEqual(1.5)
  if (header.closeOffset !== null) expect(Math.abs(header.closeOffset), `header: ${JSON.stringify(header)} (close button level with the title)`).toBeLessThanOrEqual(2)
  if (footer) {
    expect(buttons.length, 'footer buttons').toBeGreaterThan(0)
    for (const { label, box } of buttons) {
      expect(inside(box, panel), `footer button “${label}” ${JSON.stringify(box)} inside the dialog panel ${JSON.stringify(panel)}`).toBe(true)
    }
  }
  const results = await new AxeBuilder({ page }).include('[role="dialog"], [role="alertdialog"]').analyze()
  const blocking = results.violations.filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
  expect(blocking.map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`), `axe in ${name}`).toEqual([])
  if (!keepOpen) {
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
  }
}

async function arriving(api: Api, name: string, extra: { email?: string; sendInvitation?: boolean } = {}): Promise<{ visit: Visit; passUrl: string }> {
  const now = Date.now()
  const created = await api.createVisit({
    visitor: { full_name: name, company_name: 'Atlas Freight', phone: '+962 79 555 0180', ...(extra.email ? { email: extra.email } : {}) },
    start: new Date(now - minutes(2)),
    end: new Date(now + minutes(58)),
    purpose: 'Logistics planning session',
    sendInvitation: extra.sendInvitation ?? false,
  })
  return { visit: created.visit, passUrl: created.pass_url }
}

test('administration dialogs: departments, users and unsaved settings', async ({ open }) => {
  const tag = uniqueTag()
  const { page } = await open({ as: 'otherAdmin' })

  await page.goto('/admin/departments')
  await page.getByRole('button', { name: 'Add department' }).click()
  await checkDialog(page, modal(page, 'Add department'))
  await page.getByRole('button', { name: 'Rename Finance' }).click()
  await checkDialog(page, modal(page, 'Rename Finance'))
  await page.getByRole('button', { name: 'Deactivate Finance' }).click()
  await checkDialog(page, modal(page, 'Deactivate Finance?'))

  await page.goto('/admin/users')
  await page.getByRole('button', { name: 'Add user' }).click()
  const add = modal(page, 'Add user')
  await checkDialog(page, add, { keepOpen: true })
  const name = `Dalia Faris ${tag}`
  await add.getByLabel('Full name').fill(name)
  await add.getByLabel('Email', { exact: true }).fill(`dalia.faris.${tag}@other.local`)
  await add.getByRole('checkbox', { name: 'Management', exact: true }).check()
  await add.getByRole('button', { name: 'Generate' }).click()
  await add.getByRole('button', { name: 'Create user' }).click()
  const created = modal(page, 'User created')
  await checkDialog(page, created, { keepOpen: true })
  await created.getByRole('button', { name: 'Done' }).click()
  await page.getByRole('button', { name: `Edit ${name}` }).click()
  await checkDialog(page, modal(page, `Edit ${name}`))

  await page.goto('/admin/settings')
  await page.getByRole('textbox', { name: /^Address/ }).fill(`Unsaved address ${tag}`)
  await followNavLink(page, 'Users')
  await checkDialog(page, modal(page, 'Leave without saving?'))
  await expect(page).toHaveURL(/\/admin\/settings$/)
})

test('visit and visitor dialogs: edit, cancel, resend, new pass link, QR code, failed invitation', async ({ open, apiAs }) => {
  const tag = uniqueTag()
  const host = await apiAs('otherEmployee')
  const sent = await arriving(host, `Hana Saad ${tag}`, { email: `hana.saad.${tag}@guest.test`, sendInvitation: true })
  const shared = await arriving(host, `Ziad Qasem ${tag}`)
  const failed = await arriving(host, `Rami Odeh ${tag}`, { email: `rami.${tag}@${FAIL_DOMAIN}`, sendInvitation: true })
  await host.settledInvitation(sent.visit.id)
  expect((await host.settledInvitation(failed.visit.id)).invitation.status).toBe('FAILED')
  const { page } = await open({ as: 'otherEmployee' })

  await page.goto(`/visits/${sent.visit.id}`)
  await page.getByRole('button', { name: 'Edit or reschedule' }).click()
  await checkDialog(page, modal(page, 'Edit or reschedule visit'))
  await page.getByRole('button', { name: 'Cancel visit' }).click()
  await checkDialog(page, modal(page, 'Cancel this visit?'))
  await page.getByRole('button', { name: 'Resend invitation' }).click()
  await checkDialog(page, modal(page, 'Resend the invitation?'))

  await page.goto(`/visitors/${sent.visit.visitor.id}`)
  await page.getByRole('button', { name: 'Edit visitor' }).click()
  await checkDialog(page, modal(page, 'Edit visitor'))

  await page.goto(`/visits/${shared.visit.id}`)
  await page.getByRole('button', { name: 'Issue a new pass link' }).click()
  const issue = modal(page, 'Issue a new pass link?')
  await checkDialog(page, issue, { keepOpen: true })
  await issue.getByRole('button', { name: 'Issue new pass link' }).click()
  await expect(page.getByRole('heading', { name: 'New visitor pass' })).toBeVisible()
  await page.getByRole('button', { name: 'Show QR code' }).click()
  await checkDialog(page, modal(page, 'Visitor pass QR code'))

  await page.goto(`/visits/${failed.visit.id}`)
  await page.getByRole('button', { name: 'Correct email and resend' }).click()
  await checkDialog(page, modal(page, 'Correct the email address'))
  // Three actions in the footer: the widest one (it must wrap inside the panel, never out of it).
  await page.getByRole('button', { name: 'Resend to same address' }).click()
  const again = modal(page, 'Send the invitation again?')
  await expect(again.locator('footer').getByRole('button')).toHaveCount(3)
  await checkDialog(page, again)
})

test('reception list dialogs: check-in, check-out, corrected and bulk check-out, visitor search', async ({ open, apiAs }) => {
  const tag = uniqueTag()
  const host = await apiAs('otherEmployee')
  const reception = await apiAs('otherReception')
  const expected = await arriving(host, `Mona Aziz ${tag}`)
  const insideNow = await arriving(host, `Fadi Nasr ${tag}`)
  await reception.checkIn(insideNow.visit.id, { method: 'MANUAL' })
  const stale = await arriving(host, `Ola Hamdan ${tag}`)
  await reception.checkIn(stale.visit.id, { method: 'MANUAL' })
  await timeTravel(stale.visit.id, 26 * 60)
  const { page } = await open({ as: 'otherReception' })

  await page.goto('/reception?tab=expected')
  await page.getByRole('listitem').filter({ hasText: expected.visit.visitor.full_name }).getByRole('button', { name: 'Verify ID & check in' }).click()
  await checkDialog(page, modal(page, 'Verify ID and check in'))

  await page.goto('/reception?tab=inside')
  const row = page.getByRole('list', { name: 'Visitors inside' }).getByRole('listitem').filter({ hasText: insideNow.visit.visitor.full_name })
  await row.getByRole('button', { name: 'Check out' }).click()
  await checkDialog(page, modal(page, `Check out ${insideNow.visit.visitor.full_name}?`))
  await row.getByRole('button', { name: `More actions for ${insideNow.visit.visitor.full_name}` }).click()
  await page.getByRole('menuitem', { name: 'Correct check-out time' }).click()
  await checkDialog(page, modal(page, 'Correct check-out time'))
  await page.getByRole('button', { name: 'Check out remaining from previous days' }).click()
  await checkDialog(page, modal(page, 'Check out visitors from previous days'))

  await page.getByRole('button', { name: 'Find a visitor' }).click()
  await checkDialog(page, modal(page, 'Find a visitor'), { footer: false })
})

test('scanner dialogs: confirm an early check-out, check in anyway', async ({ apiAs, open }) => {
  const tag = uniqueTag()
  const host = await apiAs('otherEmployee')
  const receptionApi = await apiAs('otherReception')
  const timeZone = (await host.me()).company.timezone
  const insideNow = await arriving(host, `Basel Karam ${tag}`)
  await receptionApi.checkIn(insideNow.visit.id, { method: 'QR', pass_token: passToken(insideNow.passUrl) })
  const now = Date.now()
  const late = await host.createVisit({ visitor: { full_name: `Jana Saleh ${tag}` }, start: new Date(now + minutes(5)), end: new Date(now + minutes(20)) })
  await timeTravel(late.visit.id, Math.ceil((Date.parse(late.visit.window_end) - now) / 60_000) + 2)
  const sameDay = localDate((await host.visit(late.visit.id)).scheduled_start, timeZone) === localDate(Date.now(), timeZone)
  const { page } = await open({ as: 'otherReception' })

  await page.goto('/reception')
  await scanPass(page, insideNow.passUrl)
  await scanResult(page).getByRole('button', { name: 'Check out…' }).click()
  await checkDialog(page, modal(page, `Check out ${insideNow.visit.visitor.full_name}?`))
  await scanResult(page).getByRole('button', { name: 'Scan next' }).click()

  await scanPass(page, late.pass_url)
  if (!sameDay) {
    test.info().annotations.push({ type: 'note', description: 'Close to company-local midnight: the expired visit is on the previous day, so “Check in anyway” is not offered and its dialog is not checked in this run.' })
    return
  }
  await scanResult(page).getByRole('button', { name: 'Check in anyway…' }).click()
  await checkDialog(page, modal(page, 'Check in anyway'))
})

test('phase 11 dialogs: a company’s page of the platform owner, and the e-mail texts’ reset', async ({ open }) => {
  // The platform owner's dialogs on Other Corp's page; each is closed with Escape, so nothing changes.
  const owner = await open({ platform: true })
  await owner.page.goto('/platform/companies')
  await owner.page.getByRole('link', { name: 'Other Corp' }).click()
  await expect(owner.page.getByRole('heading', { level: 1, name: 'Other Corp' })).toBeVisible()
  await owner.page.getByRole('button', { name: 'Edit', exact: true }).click()
  await checkDialog(owner.page, modal(owner.page, 'Edit Other Corp'))
  await owner.page.getByRole('button', { name: 'Deactivate', exact: true }).click()
  await checkDialog(owner.page, modal(owner.page, 'Deactivate Other Corp?'))
  await owner.page.getByRole('button', { name: 'Add administrator' }).click()
  await checkDialog(owner.page, modal(owner.page, 'Add administrator'))

  // "Reset to default" is offered once a text is the company's own: the read is answered with one changed
  // text (nothing is saved; the texts are company-wide and another spec edits the invitation's).
  const { page } = await open({ as: 'otherAdmin' })
  await page.route('**/api/v1/email-templates/HOST_ARRIVAL', async (route) => {
    if (route.request().method() !== 'GET') return route.continue()
    const response = await route.fetch()
    const template = (await response.json()) as { updated_at: string | null; fields: { name: string; override: { ar: string | null; en: string | null } }[] }
    template.updated_at = '2026-10-05T07:00:00Z'
    template.fields.find((field) => field.name === 'closing')!.override.en = 'Please meet {visitor_name} at the desk.'
    return route.fulfill({ response, json: template })
  })
  await page.goto('/admin/email-templates/HOST_ARRIVAL')
  await expect(page.getByRole('heading', { level: 1, name: 'Visitor arrival' })).toBeVisible()
  await page.getByRole('button', { name: 'Reset to default texts' }).click()
  await checkDialog(page, modal(page, 'Reset to the default texts?'))
})
