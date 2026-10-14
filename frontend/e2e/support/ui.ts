import { expect, type Locator, type Page, type Response } from '@playwright/test'
import { wallParts } from './time.ts'

/*
 * Screen helpers shared by the specs. They use what a person sees (roles, labels, button text), the
 * stable hooks the feature decisions name (e.g. phase-5-7-frontend-reception.md #36).
 */

export async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Sign in' }).click()
}

/** The forced change after a sign-in with a temporary password (§7.2, D-11). */
export async function changeTemporaryPassword(page: Page, temporary: string, next: string): Promise<void> {
  await expect(page).toHaveURL(/\/change-password$/)
  await expect(page.getByText('Choose a new password to continue')).toBeVisible()
  await page.getByLabel('Current password').fill(temporary)
  await page.getByLabel('New password', { exact: true }).fill(next)
  await page.getByLabel('Confirm new password').fill(next)
  await page.getByRole('button', { name: 'Change password' }).click()
  await expect(page).not.toHaveURL(/\/change-password$/)
}

/** A random password that passes the policy (length, not common, not built from words). */
export function strongPassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'
  const bytes = crypto.getRandomValues(new Uint8Array(20))
  return `Q7-${Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('')}-x9`
}

/** A short random tag that keeps names and addresses unique per run and per retry. */
export function uniqueTag(): string {
  return `${Date.now().toString(36).slice(-5)}${Math.random().toString(36).slice(2, 6)}`
}

/** Sets a DateTimeField (a date input and a 15-minute time list) to an instant, in company wall time. */
export async function setDateTime(scope: Page | Locator, label: string, instant: Date, timeZone: string): Promise<void> {
  const { date, time } = wallParts(instant, timeZone)
  // The field is a group named by its label: a native date input and a select of times.
  const group = scope.getByRole('group', { name: label, exact: true })
  await group.locator('input[type="date"]').fill(date)
  await group.getByRole('combobox').selectOption(time)
  await expect(group.locator('input[type="date"]')).toHaveValue(date)
  await expect(group.getByRole('combobox')).toHaveValue(time)
}

/** Picks an option of an async combobox (host or returning-visitor typeahead). */
export async function pickFromCombobox(page: Page, label: string, query: string, option: string | RegExp): Promise<void> {
  const combobox = page.getByRole('combobox', { name: label })
  await combobox.fill(query)
  await page.getByRole('option', { name: option }).first().click()
}

export function waitForApi(page: Page, method: string, path: RegExp | string): Promise<Response> {
  return page.waitForResponse((response) => {
    const url = new URL(response.url())
    if (response.request().method() !== method || !url.pathname.startsWith('/api/v1/')) return false
    const apiPath = url.pathname.slice('/api/v1'.length)
    return typeof path === 'string' ? apiPath === path : path.test(apiPath)
  })
}

/** The reception scanner's result region. */
export function scanResult(page: Page): Locator {
  return page.getByRole('region', { name: 'Scan result' })
}

/**
 * Text shown in the scan result. The region's polite status line announces the same words to
 * screen readers (`scanAnnouncement`), so it is left out here; `scanAnnouncement` reads it.
 */
export function resultText(page: Page, text: string | RegExp): Locator {
  return scanResult(page)
    .getByText(text, { exact: typeof text === 'string' })
    .and(page.locator(':not([role="status"])'))
}

/** The scan result's screen-reader announcement (a `status` live region). */
export function scanAnnouncement(page: Page): Locator {
  return scanResult(page).getByRole('status')
}

/**
 * Types or pastes a pass like a handheld scanner (it types the text and presses Enter). On touch
 * screens the field is collapsed behind "Enter or paste pass" (§10) and is opened first.
 */
export async function enterPass(page: Page, pass: string): Promise<void> {
  const field = page.getByLabel('Scan or paste a pass')
  const toggle = page.getByRole('button', { name: 'Enter or paste pass' })
  await expect(field.or(toggle).first()).toBeVisible()
  if (!(await field.isVisible())) await toggle.click()
  await field.fill(pass)
  await field.press('Enter')
}

/**
 * Chooses a radio option by tapping its label, as a person does: segmented options hide the
 * native input (`sr-only`) behind a label styled as a button.
 */
export async function chooseRadio(scope: Page | Locator, name: string): Promise<void> {
  const radio = scope.getByRole('radio', { name, exact: true })
  if (!(await radio.isChecked())) {
    const id = await radio.getAttribute('id')
    await scope.locator(`label[for="${id}"]`).click()
  }
  await expect(radio).toBeChecked()
}

/** Enters a pass and waits for the server's verdict (`POST /reception/scan`). */
export async function scanPass(page: Page, pass: string): Promise<Response> {
  const response = waitForApi(page, 'POST', '/reception/scan')
  await enterPass(page, pass)
  return response
}

/** Follows a main-navigation link: the sidebar from 1024 px, the drawer ("Open navigation") below. */
export async function followNavLink(page: Page, name: string): Promise<void> {
  const openDrawer = page.getByRole('button', { name: 'Open navigation' })
  if (await openDrawer.isVisible()) await openDrawer.click()
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name, exact: true }).click()
}

/** Resolves after `count` animation frames (layout, ResizeObserver and media-query listeners have run). */
export function afterFrames(page: Page, count = 1): Promise<void> {
  return page.evaluate(
    (frames) =>
      new Promise<void>((resolve) => {
        const step = (left: number) => (left === 0 ? resolve() : requestAnimationFrame(() => step(left - 1)))
        step(frames)
      }),
    count,
  )
}

/** No horizontal scrolling of the page (the document is not wider than the viewport). */
export async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - document.documentElement.clientWidth)
}
