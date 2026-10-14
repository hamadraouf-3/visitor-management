import type { Page } from '@playwright/test'
import { PLATFORM_ACCOUNT } from '../support/accounts.ts'
import { SEED_PASSWORD } from '../support/env.ts'
import { expect, test } from '../support/fixtures.ts'
import { waitForMessage } from '../support/outbox.ts'
import { changeTemporaryPassword, signIn, strongPassword, uniqueTag } from '../support/ui.ts'

/*
 * The platform owner (Phase 11, B11-1 … B11-13), through the UI from end to end:
 * - signs in at /platform/login (a browser with no session; a company session would not count);
 * - creates a company with its first administrator, the slug suggested from the name and the
 *   temporary password shown once;
 * - that administrator signs in with the temporary password and must change it, then reaches the
 *   company's administration;
 * - the platform owner deactivates the company (after one line of confirmation): the administrator's
 *   session ends on the company's sign-in page, which shows no identity any more and which the device
 *   then forgets (Phase 12: a deactivated company answers as one nobody has); with the right password
 *   the sign-in says the company is deactivated (B11-46), with a wrong one it gives the one answer of
 *   wrong credentials;
 * - reactivated, the administrator signs in again;
 * - a second administrator is added and a reset link sent: the company's other administrator is told
 *   by e-mail each time (B11-43), and the reset e-mail says who sent it (B11-49);
 * - of the platform's requests, only the session's own re-checks are sent as background refreshes;
 * - the platform's audit log for the company records the creation, the deactivation and the
 *   reactivation, and the company's own audit log names the platform owner for them.
 * The company is the spec's own: nothing seeded is deactivated.
 */

async function platformSignIn(page: Page) {
  await page.goto('/platform/login')
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in to the platform' })).toBeVisible()
  await page.getByLabel('Email').fill(PLATFORM_ACCOUNT.email)
  await page.getByLabel('Password', { exact: true }).fill(SEED_PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Companies' })).toBeVisible()
}

test('platform owner: a new company and its administrator, deactivated and reactivated', async ({ open }) => {
  const tag = uniqueTag()
  const companyName = `Nova Labs ${tag}`
  const adminName = `Nadia Haddad ${tag}`
  const adminEmail = `nadia.${tag}@nova.test`
  const newPassword = strongPassword()

  // The platform owner signs in, in a browser of its own. Its requests are noted: which ones say they are background refreshes.
  const owner = await open({ device: 'desktop' })
  const platformRequests: { call: string; background: boolean }[] = []
  owner.page.on('request', (request) => {
    const path = new URL(request.url()).pathname
    if (path.startsWith('/api/v1/platform/')) platformRequests.push({ call: `${request.method()} ${path.replace('/api/v1', '')}`, background: request.headers()['x-background-refresh'] === '1' })
  })
  await platformSignIn(owner.page)
  await expect(owner.page.getByText('Platform', { exact: true }).first()).toBeVisible()

  // A company and its first administrator.
  await owner.page.getByRole('link', { name: 'Add company' }).first().click()
  await expect(owner.page.getByRole('heading', { level: 1, name: 'Add company' })).toBeVisible()
  await owner.page.getByLabel('Company name').fill(companyName)
  await expect(owner.page.getByLabel('Slug')).toHaveValue(`nova-labs-${tag}`)
  await owner.page.getByRole('radio', { name: 'English' }).check({ force: true })
  await owner.page.getByLabel('Full name').fill(adminName)
  await owner.page.getByLabel('Email').fill(adminEmail)
  await owner.page.getByRole('button', { name: 'Generate' }).click()
  const temporary = await owner.page.getByLabel('Temporary password').inputValue()
  expect(temporary.length).toBeGreaterThanOrEqual(12)
  await owner.page.getByRole('button', { name: 'Create company' }).click()

  await expect(owner.page.getByRole('heading', { level: 1, name: 'Company created' })).toBeVisible()
  await expect(owner.page.getByText(`${adminName} can now sign in`)).toBeVisible()
  await expect(owner.page.getByLabel('Temporary password')).toHaveValue(temporary)
  await owner.page.getByRole('link', { name: 'Open company' }).click()
  await expect(owner.page.getByRole('heading', { level: 1, name: companyName })).toBeVisible()
  const admins = owner.page.getByRole('list', { name: `Administrators of ${companyName}` })
  await expect(admins.getByText(adminEmail)).toBeVisible()
  await expect(admins.getByText('Temporary password')).toBeVisible()

  // The new administrator signs in with the temporary password and must change it.
  const admin = await open({ device: 'desktop' })
  await signIn(admin.page, adminEmail, temporary)
  await changeTemporaryPassword(admin.page, temporary, newPassword)
  await expect(admin.page.getByRole('heading', { level: 1, name: 'Admin dashboard' })).toBeVisible()

  // Deactivated: one line first, then the administrator's session ends and signing in is refused.
  await owner.page.getByRole('button', { name: 'Deactivate', exact: true }).click()
  const confirm = owner.page.getByRole('alertdialog', { name: `Deactivate ${companyName}?` })
  await expect(confirm).toContainText('Its users are signed out and cannot sign in, and its visitor passes stop working.')
  await confirm.getByRole('button', { name: 'Deactivate company' }).click()
  await expect(owner.page.getByRole('button', { name: 'Reactivate' })).toBeVisible()
  await expect(owner.page.getByText('Deactivated', { exact: true }).first()).toBeVisible()

  // The device remembered its company, so the ended session leads to that company's sign-in page. A
  // deactivated company has no public identity: the page is the one of no company, and the device
  // forgets the company, so /login is the plain sign-in page again.
  await admin.page.reload()
  await expect(admin.page).toHaveURL(new RegExp(`/c/nova-labs-${tag}(\\?|$)`))
  await expect(admin.page.locator('[data-neutral-mark]')).toBeVisible()
  await expect(admin.page.locator('[data-identity-lockup]')).toHaveCount(0)
  await expect.poll(() => admin.page.evaluate(() => window.localStorage.getItem('vms.company'))).toBeNull()
  // The right password: the deactivation is the only obstacle, and the page says so (409 COMPANY_INACTIVE).
  await signIn(admin.page, adminEmail, newPassword)
  await expect(admin.page.getByRole('alert').filter({ hasText: 'This company is deactivated.' })).toBeVisible()
  await expect(admin.page.getByText('Invalid email or password.')).toHaveCount(0)
  await expect(admin.page).toHaveURL(/\/login/)
  await expect(admin.page.getByRole('button', { name: 'Sign in' })).toBeEnabled()
  // A wrong password learns nothing about the company: the one answer of wrong credentials.
  await signIn(admin.page, adminEmail, `${newPassword}-wrong`)
  await expect(admin.page.getByRole('alert').filter({ hasText: 'Invalid email or password.' })).toBeVisible()
  await expect(admin.page.getByText('This company is deactivated.')).toHaveCount(0)

  // Reactivated: the administrator signs in again.
  await owner.page.getByRole('button', { name: 'Reactivate' }).click()
  await expect(owner.page.getByRole('button', { name: 'Deactivate', exact: true })).toBeVisible()
  await signIn(admin.page, adminEmail, newPassword)
  await expect(admin.page.getByRole('heading', { level: 1, name: 'Admin dashboard' })).toBeVisible()

  // A second administrator for the existing company: the first one, its other active administrator, is told by e-mail.
  const secondName = `Rami Saleh ${tag}`
  const secondEmail = `rami.${tag}@nova.test`
  await owner.page.getByRole('button', { name: 'Add administrator' }).click()
  const add = owner.page.getByRole('dialog', { name: 'Add administrator' })
  await add.getByLabel('Full name').fill(secondName)
  await add.getByLabel('Email').fill(secondEmail)
  await add.getByRole('button', { name: 'Generate' }).click()
  const secondPassword = await add.getByLabel('Temporary password').inputValue()
  await add.getByRole('button', { name: 'Add administrator' }).click()
  const added = owner.page.getByRole('dialog', { name: 'Administrator added' })
  await expect(added.getByText(`${secondName} can now sign in`)).toBeVisible()
  await expect(added.getByText(secondEmail)).toBeVisible()
  await expect(added.getByLabel('Temporary password')).toHaveValue(secondPassword)
  await added.getByRole('button', { name: 'Done' }).click()
  const addedNotice = await waitForMessage({ kind: 'PLATFORM_ACTION_NOTICE', to: adminEmail })
  expect(addedNotice.subject).toContain(`A new administrator was added to ${companyName}`)
  expect(addedNotice.text).toContain(`The platform owner added a new administrator account to ${companyName}`)
  // A notice: no credential and no link to act on.
  expect(addedNotice.text).not.toContain(secondPassword)
  expect(addedNotice.reset_url).toBeNull()
  // It is the company's own e-mail to its administrators: headed and signed by the company, and nothing of the product.
  const [masthead, rule] = addedNotice.text.split(/\r?\n/)
  expect(masthead).toContain(companyName)
  expect(rule).toMatch(/^=+$/)
  expect(addedNotice.text).toContain(`Sent by ${companyName}.`)
  for (const part of [addedNotice.subject, addedNotice.html, addedNotice.text]) {
    expect(part).not.toContain('Mawdoo3')
    expect(part).not.toContain('موضوع')
  }

  // A reset link for the first administrator: the product's reset e-mail says who sent it, and the other administrator is told.
  await owner.page.getByRole('button', { name: `Send reset link to ${adminName}` }).click()
  await expect(owner.page.getByText('Reset link sent')).toBeVisible()
  await expect(owner.page.getByText(`To ${adminEmail}`)).toBeVisible()
  const reset = await waitForMessage({ kind: 'PASSWORD_RESET', to: adminEmail })
  expect(reset.text).toContain(`The platform owner sent you a link to set a new password for your ${companyName} account.`)
  expect(reset.reset_url).toBeTruthy()
  const resetNotice = await waitForMessage({ kind: 'PLATFORM_ACTION_NOTICE', to: secondEmail })
  expect(resetNotice.text).toContain(`The platform owner sent a password-reset link to an administrator of ${companyName}`)

  // The platform's audit log, narrowed to the company.
  // Not named as the navigation's whole log is.
  await owner.page.getByRole('main').getByRole('link', { name: "This company's audit log" }).click()
  await expect(owner.page.getByText(`Company: ${companyName}`)).toBeVisible()
  const events = owner.page.getByRole('list', { name: 'Platform audit events, newest first' })
  for (const action of ['Company reactivated', 'Company deactivated', 'Company created', 'User created']) {
    await expect(events.getByText(action, { exact: true }).first()).toBeVisible()
  }
  // The rows about the administrators say who, not only "User".
  await expect(events.getByRole('listitem').filter({ hasText: 'User created' }).filter({ hasText: adminName })).toContainText(`User: ${adminName}`)
  await expect(events.getByRole('listitem').filter({ hasText: 'User created' }).filter({ hasText: secondName })).toContainText(`User: ${secondName}`)
  await expect(events.getByRole('listitem').filter({ hasText: 'Password reset requested' })).toContainText(`User: ${adminName}`)

  // What the platform owner asked for was never sent as a background refresh (it would not count as
  // activity, B11-34); only the session's own re-checks may be.
  const marked = platformRequests.filter((request) => request.background).map((request) => request.call)
  expect(marked.filter((call) => call !== 'GET /platform/auth/me')).toEqual([])
  const asked = platformRequests.filter((request) => !request.background).map((request) => request.call)
  expect(asked).toEqual(expect.arrayContaining(['POST /platform/auth/login', 'POST /platform/companies', 'GET /platform/audit-logs']))

  // The company's own audit log names the platform owner, never "System".
  await admin.page.goto('/admin/audit')
  const companyEvents = admin.page.getByRole('list', { name: 'Audit events, newest first' })
  // The action, not a refused sign-in of the deactivated company (whose reason reads 'Deactivated company').
  const deactivation = companyEvents.getByRole('listitem').filter({ hasText: 'Company deactivated' }).filter({ hasNotText: 'Sign-in failed' })
  await expect(deactivation).toContainText('Platform owner')
})

test('a company session never opens the platform owner’s pages', async ({ open }) => {
  const { page } = await open({ as: 'admin', device: 'desktop' })
  await page.goto('/platform/companies')
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in to the platform' })).toBeVisible()
  await expect(page).toHaveURL(/\/platform\/login/)
  // The company session is still there for its own pages.
  await page.goto('/admin')
  await expect(page.getByRole('heading', { level: 1, name: 'Admin dashboard' })).toBeVisible()
})

test('the platform session never opens a company’s pages', async ({ open }) => {
  const { page } = await open({ platform: true, device: 'desktop' })
  await page.goto('/admin/users')
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible()
  await page.goto('/platform/companies')
  await expect(page.getByRole('heading', { level: 1, name: 'Companies' })).toBeVisible()
})
