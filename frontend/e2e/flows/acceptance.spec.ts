import { createHash } from 'node:crypto'
import type { Page } from '@playwright/test'
import type { AuditLog, Department, ScanResult, User, Visit, VisitCreate, VisitCreateResult } from '../../src/types/api.ts'
import { ACCOUNTS } from '../support/accounts.ts'
import { Api, passToken } from '../support/api.ts'
import { queryOne, queryRows, uuid } from '../support/db.ts'
import { SEED_PASSWORD } from '../support/env.ts'
import { expect, test } from '../support/fixtures.ts'
import { findMessages, inlineImages, waitForMessage } from '../support/outbox.ts'
import { BASE_URL } from '../support/paths.ts'
import { decodeQrImage } from '../support/qr.ts'
import { localDate, minutes, nextQuarterHour, wallTimeToInstant } from '../support/time.ts'
import {
  changeTemporaryPassword,
  chooseRadio,
  pickFromCombobox,
  resultText,
  scanPass,
  scanResult,
  setDateTime,
  signIn,
  strongPassword,
  uniqueTag,
  waitForApi,
} from '../support/ui.ts'

/*
 * The acceptance scenario of the brief (§40, steps 1–28), end to end against the real API and
 * database, through the UI wherever a UI exists. Each step is a `test.step` titled with its §40
 * number and asserts its outcome explicitly (UI, API and, where the step is about storage, the
 * database). Every person has their own browser context: the administrator, the new employee and
 * the other users on a desktop, the new receptionist on a tablet (820 × 1180, touch), scanning
 * through the handheld-scanner / paste input. The real-camera path is e2e/camera/camera-scan.spec.ts.
 */

const VISITOR = { name: 'Hamad Raouf', company: 'Raouf Trading', phone: '+962 79 555 0142' }
const MAIN_PURPOSE = 'Quarterly supplier review'
const PREVIOUS_PURPOSE = 'Introductory meeting about the supply contract'

/** What a visit's history must keep (§5: a visit is never changed by another visit's lifecycle). */
function durableFields(visit: Visit) {
  return {
    id: visit.id,
    status: visit.status,
    visitor: visit.visitor,
    host: { id: visit.host.id, full_name: visit.host.full_name },
    department: visit.department,
    purpose: visit.purpose,
    scheduled_start: visit.scheduled_start,
    scheduled_end: visit.scheduled_end,
    window_start: visit.window_start,
    window_end: visit.window_end,
    check_in_at: visit.check_in_at,
    check_out_at: visit.check_out_at,
    cancelled_at: visit.cancelled_at,
    no_show_at: visit.no_show_at,
    created_at: visit.created_at,
    updated_at: visit.updated_at,
    invitation: visit.invitation,
    pass: visit.pass,
  }
}

/** formatDuration (src/utils/duration.ts), the "Time on site" text. */
function durationText(seconds: number): string {
  if (seconds < 60) return '< 1m'
  const hours = Math.floor(seconds / 3600)
  const mins = Math.floor((seconds % 3600) / 60)
  if (hours === 0) return `${mins}m`
  return mins === 0 ? `${hours}h` : `${hours}h ${mins}m`
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** An admin-created account through Users → Add user, with a generated temporary password. */
async function createUserThroughUi(page: Page, input: { name: string; email: string; phone?: string; role: string; department?: string }) {
  await page.goto('/admin/users')
  await expect(page.getByRole('heading', { level: 1, name: 'Users' })).toBeVisible()
  await page.getByRole('button', { name: 'Add user' }).click()
  const dialog = page.getByRole('dialog', { name: 'Add user' })
  await dialog.getByLabel('Full name').fill(input.name)
  await dialog.getByLabel('Email', { exact: true }).fill(input.email)
  if (input.phone) await dialog.getByLabel('Phone (optional)').fill(input.phone)
  if (input.department) await dialog.getByLabel('Department (optional)').selectOption({ label: input.department })
  await dialog.getByRole('checkbox', { name: input.role, exact: true }).check()
  await dialog.getByRole('button', { name: 'Generate' }).click()
  const temporaryPassword = await dialog.getByLabel('Temporary password').inputValue()
  expect(temporaryPassword.length).toBeGreaterThanOrEqual(12)

  const created = waitForApi(page, 'POST', '/users')
  await dialog.getByRole('button', { name: 'Create user' }).click()
  const response = await created
  expect(response.status()).toBe(201)
  const user = (await response.json()) as User

  const done = page.getByRole('dialog', { name: 'User created' })
  await expect(done.getByText(`${input.name} can now sign in`)).toBeVisible()
  // Shown once, so the administrator can pass it on (D-11).
  await expect(done.getByLabel('Temporary password')).toHaveValue(temporaryPassword)
  await done.getByRole('button', { name: 'Done' }).click()
  await expect(done).toBeHidden()
  return { user, temporaryPassword }
}

/** Opens the audit log filtered by `query` and expects an event with each label. */
async function expectAuditEvents(page: Page, query: string, labels: readonly string[]) {
  await page.goto(`/admin/audit?${query}`)
  const list = page.getByRole('list', { name: 'Audit events, newest first' })
  await expect(list).toBeVisible()
  for (const label of labels) {
    await expect(list.getByRole('button', { name: new RegExp(`^Details: ${escapeRegExp(label)},`) }).first(), `audit event “${label}” for ${query}`).toBeVisible()
  }
}

test('§40 acceptance: invite, scan, check in and out, history, audit and access control', async ({ open, apiAs }) => {
  test.setTimeout(6 * 60_000)
  const tag = uniqueTag()
  const adminApi = await apiAs('admin')
  const timeZone = (await adminApi.me()).company.timezone
  const departmentName = `Visitor Relations ${tag}`
  const employeeInput = { name: 'Yara Haddad', email: `yara.haddad.${tag}@demo.local`, phone: '+962 79 555 0101' }
  const receptionistInput = { name: 'Khaled Odeh', email: `khaled.odeh.${tag}@demo.local` }
  const visitorEmail = `hamad.raouf.${tag}@guest.test`
  const employeePassword = strongPassword()
  const receptionistPassword = strongPassword()

  const admin = await open({ device: 'desktop' })
  const employee = await open({ device: 'desktop' })
  const reception = await open({ device: 'tablet' })

  let department!: Department
  let employeeUser!: User
  let receptionistUser!: User
  let employeeTemporary = ''
  let receptionistTemporary = ''
  let previous!: VisitCreateResult
  let main!: VisitCreateResult
  let mainStart!: Date
  let checkedIn!: Visit
  let checkedOut!: Visit

  await test.step('§40 step 1: the administrator signs in', async () => {
    await signIn(admin.page, ACCOUNTS.admin.email, SEED_PASSWORD)
    await expect(admin.page).toHaveURL(/\/admin$/)
    await expect(admin.page.getByRole('heading', { level: 1, name: 'Admin dashboard' })).toBeVisible()
    const me = await admin.api.me()
    expect(me.user.email).toBe(ACCOUNTS.admin.email)
    expect(me.user.roles).toContain('SYSTEM_ADMIN')
  })

  await test.step('§40 step 2: the administrator creates a department', async () => {
    const page = admin.page
    await page.goto('/admin/departments')
    await page.getByRole('button', { name: 'Add department' }).click()
    const dialog = page.getByRole('dialog', { name: 'Add department' })
    // "Name" exactly: the dialog also has "Arabic name (optional)" (phase 10 shared contract B).
    await dialog.getByLabel('Name', { exact: true }).fill(departmentName)
    const created = waitForApi(page, 'POST', '/departments')
    await dialog.getByRole('button', { name: 'Add department' }).click()
    const response = await created
    expect(response.status()).toBe(201)
    department = (await response.json()) as Department
    await expect(page.getByText(`${departmentName} created`)).toBeVisible()
    await expect(dialog).toBeHidden()
    await expect(page.getByText(departmentName, { exact: true }).first()).toBeVisible()
    const departments = await adminApi.ok<Department[]>('GET', '/departments')
    expect(departments).toContainEqual(expect.objectContaining({ id: department.id, name: departmentName, is_active: true }))
  })

  await test.step('§40 step 3: the administrator creates an employee with a temporary password', async () => {
    const created = await createUserThroughUi(admin.page, { ...employeeInput, role: 'Employee', department: departmentName })
    employeeUser = created.user
    employeeTemporary = created.temporaryPassword
    expect(employeeUser).toMatchObject({
      full_name: employeeInput.name,
      email: employeeInput.email,
      phone: employeeInput.phone,
      roles: ['EMPLOYEE'],
      department: { id: department.id, name: departmentName },
      is_active: true,
      must_change_password: true,
    })
  })

  await test.step('§40 step 4: the administrator creates a receptionist with a temporary password', async () => {
    const created = await createUserThroughUi(admin.page, { ...receptionistInput, role: 'Reception' })
    receptionistUser = created.user
    receptionistTemporary = created.temporaryPassword
    expect(receptionistUser).toMatchObject({ email: receptionistInput.email, roles: ['RECEPTIONIST'], must_change_password: true })
    expect(receptionistTemporary).not.toBe(employeeTemporary)
  })

  await test.step('§40 step 5: the employee signs in and must replace the temporary password', async () => {
    const page = employee.page
    await signIn(page, employeeInput.email, employeeTemporary)
    // Every other page is closed until the password is changed (§7.2).
    await expect(page).toHaveURL(/\/change-password$/)
    expect((await employee.api.me()).user.must_change_password).toBe(true)
    const blocked = await employee.api.fails('GET', '/visits', 403)
    expect(blocked.error.code).toBe('PASSWORD_CHANGE_REQUIRED')
    await changeTemporaryPassword(page, employeeTemporary, employeePassword)
    await expect(page).toHaveURL(/\/visits$/)
    await expect(page.getByRole('heading', { level: 1, name: 'My visits' })).toBeVisible()
    const me = await employee.api.me()
    expect(me.user).toMatchObject({ id: employeeUser.id, must_change_password: false })
    // The temporary password no longer signs in.
    const anonymous = await Api.anonymous()
    try {
      const refused = await anonymous.send('POST', '/auth/login', { email: employeeInput.email, password: employeeTemporary })
      expect(refused.status()).toBe(401)
    } finally {
      await anonymous.dispose()
    }
  })

  await test.step('§40 step 6: the employee creates the visitor “Hamad Raouf” (with a first visit, tomorrow)', async () => {
    const page = employee.page
    await page.goto('/visits/new')
    await expect(page.getByRole('heading', { level: 1, name: 'Invite visitor' })).toBeVisible()
    await page.getByLabel('Full name').fill(VISITOR.name)
    await page.getByLabel('Company (optional)').fill(VISITOR.company)
    await page.getByLabel('Phone (optional)').fill(VISITOR.phone)
    await chooseRadio(page, 'I’ll share the pass myself')
    await page.getByRole('textbox', { name: 'Email (optional)' }).fill(visitorEmail)
    const tomorrow = localDate(Date.now() + minutes(24 * 60), timeZone)
    const start = wallTimeToInstant(tomorrow, '10:00', timeZone)
    await setDateTime(page, 'Starts', start, timeZone)
    await setDateTime(page, 'Ends', new Date(start.getTime() + minutes(60)), timeZone)
    await page.getByLabel('Purpose').fill(PREVIOUS_PURPOSE)
    const created = waitForApi(page, 'POST', '/visits')
    await page.getByRole('button', { name: 'Create visit' }).click()
    const response = await created
    expect(response.status()).toBe(201)
    previous = (await response.json()) as VisitCreateResult
    await expect(page.getByRole('heading', { level: 1, name: 'Visit scheduled' })).toBeVisible()

    expect(previous.visit).toMatchObject({
      status: 'SCHEDULED',
      visitor: { full_name: VISITOR.name, company_name: VISITOR.company },
      host: { id: employeeUser.id },
      purpose: PREVIOUS_PURPOSE,
      invitation: { status: 'NOT_SENT' },
      pass: { status: 'ACTIVE' },
    })
    expect(Date.parse(previous.visit.scheduled_start)).toBe(start.getTime())
    const visitor = await employee.api.visitor(previous.visit.visitor.id)
    expect(visitor).toMatchObject({ full_name: VISITOR.name, email: visitorEmail, phone: VISITOR.phone, company_name: VISITOR.company })

    // The visitor is now in the employee's visitor directory.
    await page.goto('/visitors')
    await page.getByRole('searchbox', { name: 'Search visitors' }).fill('Hamad')
    await expect(page.getByRole('link', { name: VISITOR.name })).toBeVisible()
  })

  await test.step('§40 steps 7–8: the employee creates a visit with host, department, purpose, date and time', async () => {
    const page = employee.page
    await page.goto('/visits/new')
    await pickFromCombobox(page, 'Returning visitor (optional)', 'Hamad', new RegExp(VISITOR.name))
    await expect(page.getByRole('radio', { name: 'Email the invitation' })).toBeChecked()
    // The employee is the host (D-02) and cannot choose another (§7.5, phase 10 shared contract A):
    // their name, read-only, and no host picker.
    const host = page.getByRole('textbox', { name: 'Host' })
    await expect(host).toHaveValue(employeeInput.name)
    await expect(host).toHaveAttribute('readonly', '')
    await expect(page.getByRole('combobox', { name: 'Host' })).toHaveCount(0)
    await page.getByLabel('Department (optional)').selectOption({ label: departmentName })
    mainStart = nextQuarterHour(timeZone)
    const end = new Date(mainStart.getTime() + minutes(60))
    await setDateTime(page, 'Starts', mainStart, timeZone)
    await setDateTime(page, 'Ends', end, timeZone)
    await page.getByLabel('Purpose').fill(MAIN_PURPOSE)

    const created = waitForApi(page, 'POST', '/visits')
    await page.getByRole('button', { name: 'Send invitation' }).click()
    const response = await created
    expect(response.status()).toBe(201)
    const sent = response.request().postDataJSON() as VisitCreate
    expect(sent).toMatchObject({ visitor_id: previous.visit.visitor.id, host_id: employeeUser.id, purpose: MAIN_PURPOSE, send_invitation: true })
    // The host's own department is left to the server (B24-23); any other is sent.
    expect(sent.department_id ?? employeeUser.department?.id).toBe(department.id)
    main = (await response.json()) as VisitCreateResult
    expect(main.visit).toMatchObject({
      status: 'SCHEDULED',
      visitor: { id: previous.visit.visitor.id, full_name: VISITOR.name },
      host: { id: employeeUser.id, full_name: employeeInput.name },
      department: { id: department.id, name: departmentName },
      purpose: MAIN_PURPOSE,
      created_by: { id: employeeUser.id },
    })
    expect(Date.parse(main.visit.scheduled_start)).toBe(mainStart.getTime())
    expect(Date.parse(main.visit.scheduled_end)).toBe(end.getTime())
    await expect(page.getByRole('heading', { level: 1, name: 'Visit scheduled' })).toBeVisible()
    await expect(page.getByRole('heading', { level: 2, name: VISITOR.name })).toBeVisible()
  })

  await test.step('§40 step 9: a secure QR pass is generated (opaque token in the fragment, no personal data)', async () => {
    const page = employee.page
    const passUrl = main.pass_url
    // The link names the company by its slug, so the pass page shows that company's identity (Phase 12,
    // B12-14); the token is the whole fragment and nowhere else.
    expect(passUrl).toMatch(/^http:\/\/127\.0\.0\.1:5199\/pass\?c=[a-z0-9-]+#[A-Za-z0-9_-]{43}$/)
    const url = new URL(passUrl)
    expect(url.origin).toBe(BASE_URL)
    expect(url.pathname).toBe('/pass')
    expect(url.search).toBe(`?c=${(await employee.api.me()).company.slug}`)
    const token = passToken(passUrl)
    // secrets.token_urlsafe(32): 32 random bytes, base64url without padding (contract §6).
    expect(Buffer.from(token, 'base64url')).toHaveLength(32)
    expect(Buffer.from(token, 'base64url').toString('base64url')).toBe(token)
    expect(token).not.toBe(passToken(previous.pass_url))
    const personal = [VISITOR.name, 'hamad', 'raouf', visitorEmail, VISITOR.company, VISITOR.phone.replace(/\D/g, ''), employeeInput.name, employeeInput.email, main.visit.id, main.visit.visitor.id, employeeUser.id, departmentName]
    for (const value of personal) expect(passUrl.toLowerCase(), `pass URL must not contain “${value}”`).not.toContain(value.toLowerCase())

    // Stored only as its SHA-256 (contract §6); the link is shown to the host once.
    const passes = await queryRows<{ token_hash: string; revoked_at: string | null }>(`SELECT token_hash, revoked_at FROM visitor_passes WHERE visit_id = ${uuid(main.visit.id)}`)
    expect(passes).toEqual([{ token_hash: createHash('sha256').update(token).digest('hex'), revoked_at: null }])
    await expect(page.getByLabel('Pass link')).toHaveValue(passUrl)

    // The QR code the host can show encodes exactly that link.
    await page.getByRole('button', { name: 'Show QR code' }).click()
    const dialog = page.getByRole('dialog', { name: 'Visitor pass QR code' })
    const qr = dialog.getByRole('img', { name: `Visitor pass QR code for ${VISITOR.name}` })
    await expect(qr).toBeVisible()
    expect(await decodeQrImage(await qr.screenshot())).toEqual([passUrl])
    await dialog.getByRole('button', { name: 'Done' }).click()
    await expect(dialog).toBeHidden()
  })

  await test.step('§40 steps 10–11: the invitation email is sent and carries the QR code', async () => {
    const message = await waitForMessage({ kind: 'VISITOR_INVITATION', to: visitorEmail })
    // Only this visit was emailed (the first one's pass was shared by the host).
    expect(findMessages({ kind: 'VISITOR_INVITATION', to: visitorEmail })).toHaveLength(1)
    expect(message.pass_url).toBe(main.pass_url)
    expect(message.subject.length).toBeGreaterThan(0)
    expect(message.text).toContain(`Hello ${VISITOR.name}`)
    expect(message.text).toContain(`Host: ${employeeInput.name}`)
    expect(message.text).toContain(`Department: ${departmentName}`)
    expect(message.text).toContain(MAIN_PURPOSE)
    expect(message.text).toContain(main.pass_url)
    const images = inlineImages(message)
    expect(images).toHaveLength(1)
    expect(await decodeQrImage(images[0]!.bytes)).toEqual([main.pass_url])

    const visit = await employee.api.settledInvitation(main.visit.id)
    expect(visit.invitation).toMatchObject({ status: 'SENT', to_email: visitorEmail })
    await expect(employee.page.getByText(/Invitation sent to/).first()).toContainText(visitorEmail)
  })

  await test.step('§40 step 12: the receptionist signs in on a tablet', async () => {
    const page = reception.page
    await signIn(page, receptionistInput.email, receptionistTemporary)
    await changeTemporaryPassword(page, receptionistTemporary, receptionistPassword)
    await expect(page).toHaveURL(/\/reception$/)
    expect(await page.evaluate(() => [window.innerWidth, matchMedia('(pointer: coarse)').matches])).toEqual([820, true])
  })

  let scanStartedAt = 0
  await test.step('§40 steps 13–15: the receptionist opens the scanner and scans the pass; the server validates it', async () => {
    const page = reception.page
    await expect(page.getByRole('tab', { name: /^Scan/ })).toHaveAttribute('aria-selected', 'true')
    await expect(resultText(page, 'Ready to scan')).toBeVisible()
    scanStartedAt = Date.now()
    const response = await scanPass(page, main.pass_url)
    // Only the token goes to the server (parsed from the link), which validates it (§6 row 9).
    expect(response.request().postDataJSON()).toEqual({ token: passToken(main.pass_url) })
    expect(response.status()).toBe(200)
    const body = (await response.json()) as ScanResult
    expect(body).toMatchObject({ result: 'READY', visit: { id: main.visit.id }, actions: { check_in: true, check_out: false } })
  })

  await test.step('§40 step 16: the visitor’s information appears', async () => {
    const result = scanResult(reception.page)
    await expect(resultText(reception.page, 'Valid pass – ready to check in')).toBeVisible()
    await expect(result.getByRole('heading', { name: VISITOR.name })).toBeVisible()
    await expect(resultText(reception.page, `Verify ID: ${VISITOR.name}`)).toBeVisible()
    for (const fact of [VISITOR.company, employeeInput.name, departmentName, MAIN_PURPOSE]) await expect(result).toContainText(fact)
  })

  await test.step('§40 step 17: the receptionist checks the visitor in', async () => {
    const page = reception.page
    const result = scanResult(page)
    const checkIn = waitForApi(page, 'POST', `/visits/${main.visit.id}/check-in`)
    await result.getByRole('button', { name: 'Check in', exact: true }).click()
    const response = await checkIn
    expect(response.status()).toBe(200)
    expect(response.request().postDataJSON()).toEqual({ method: 'QR', pass_token: passToken(main.pass_url) })
    await expect(resultText(page, 'Checked in')).toBeVisible()
    // Ready for the next visitor without another tap (§10 auto-resume).
    await expect(resultText(page, 'Ready to scan')).toBeVisible()
    const elapsed = Date.now() - scanStartedAt
    test.info().annotations.push({ type: 'timing', description: `reception scan → check-in → ready (paste path, tablet): ${(elapsed / 1000).toFixed(1)} s` })
    expect(elapsed).toBeLessThan(10_000)
  })

  await test.step('§40 step 18: the check-in time is stored', async () => {
    checkedIn = await reception.api.visit(main.visit.id)
    expect(checkedIn).toMatchObject({ status: 'CHECKED_IN', check_in_method: 'QR', checked_in_by: { id: receptionistUser.id } })
    const checkInAt = Date.parse(checkedIn.check_in_at ?? '')
    expect(checkInAt).toBeGreaterThanOrEqual(scanStartedAt - 2_000)
    expect(checkInAt).toBeLessThanOrEqual(Date.now() + 2_000)
    const row = await queryOne<{ status: string; check_in_at: string; check_in_method: string; checked_in_by_id: string }>(
      `SELECT status, check_in_at, check_in_method, checked_in_by_id FROM visits WHERE id = ${uuid(main.visit.id)}`,
    )
    expect(row).toMatchObject({ status: 'CHECKED_IN', check_in_method: 'QR', checked_in_by_id: receptionistUser.id })
    expect(Date.parse(row.check_in_at)).toBe(checkInAt)
  })

  await test.step('§40 step 19: the host is notified by email', async () => {
    const message = await waitForMessage({ kind: 'HOST_ARRIVAL', to: employeeInput.email })
    expect(message.text).toContain(`Your visitor ${VISITOR.name} has arrived and checked in`)
    expect(message.text).toContain(MAIN_PURPOSE)
    expect(findMessages({ kind: 'HOST_ARRIVAL', to: employeeInput.email })).toHaveLength(1)
  })

  await test.step('§40 step 20: the visitor appears in “Currently inside”', async () => {
    const page = reception.page
    await page.getByRole('tab', { name: /^Inside/ }).click()
    const row = page.getByRole('list', { name: 'Visitors inside' }).getByRole('listitem').filter({ hasText: VISITOR.name })
    await expect(row).toHaveCount(1)
    await expect(row).toContainText(employeeInput.name)
    const inside = await reception.api.inside()
    expect(inside.items.map((visit) => visit.id)).toContain(main.visit.id)
  })

  await test.step('§40 step 21: the receptionist checks the visitor out', async () => {
    const page = reception.page
    const row = page.getByRole('list', { name: 'Visitors inside' }).getByRole('listitem').filter({ hasText: VISITOR.name })
    await row.getByRole('button', { name: 'Check out' }).click()
    // Checked in less than 5 minutes ago: probably someone arriving, so the list asks first (§10).
    const confirm = page.getByRole('dialog', { name: `Check out ${VISITOR.name}?` })
    const checkOut = waitForApi(page, 'POST', `/visits/${main.visit.id}/check-out`)
    await confirm.getByRole('button', { name: 'Check out' }).click()
    const response = await checkOut
    expect(response.status()).toBe(200)
    expect(response.request().postDataJSON()).toEqual({ method: 'MANUAL' })
    await expect(page.getByText(`${VISITOR.name} checked out`)).toBeVisible()
    await expect(row).toHaveCount(0)
  })

  await test.step('§40 steps 22–24: check-out time stored, status CHECKED_OUT, duration shown', async () => {
    checkedOut = await reception.api.visit(main.visit.id)
    expect(checkedOut).toMatchObject({
      status: 'CHECKED_OUT',
      check_out_method: 'MANUAL',
      checked_out_by: { id: receptionistUser.id },
      check_in_at: checkedIn.check_in_at,
      pass: { status: 'REVOKED', revoke_reason: 'VISIT_COMPLETED' },
    })
    const inAt = Date.parse(checkedOut.check_in_at ?? '')
    const outAt = Date.parse(checkedOut.check_out_at ?? '')
    expect(outAt).toBeGreaterThanOrEqual(inAt)
    expect(checkedOut.duration_seconds).toBe(Math.floor((outAt - inAt) / 1000))
    const row = await queryOne<{ status: string; check_out_at: string; check_out_method: string }>(
      `SELECT status, check_out_at, check_out_method FROM visits WHERE id = ${uuid(main.visit.id)}`,
    )
    expect(row).toMatchObject({ status: 'CHECKED_OUT', check_out_method: 'MANUAL' })
    expect(Date.parse(row.check_out_at)).toBe(outAt)

    const page = reception.page
    await page.goto(`/visits/${main.visit.id}`)
    await expect(page.getByRole('heading', { level: 1, name: VISITOR.name })).toBeVisible()
    await expect(page.getByText('Checked out', { exact: true }).first()).toBeVisible()
    const duration = page.locator('dt', { hasText: 'Time on site' }).locator('xpath=following-sibling::dd[1]')
    await expect(duration).toHaveText(durationText(checkedOut.duration_seconds ?? -1))
  })

  await test.step('§40 step 25: the visitor’s profile shows the visit in the history', async () => {
    const page = employee.page
    await page.goto(`/visitors/${main.visit.visitor.id}`)
    await expect(page.getByRole('heading', { level: 1, name: VISITOR.name })).toBeVisible()
    const history = page.getByRole('table', { name: 'Visit history' })
    await expect(history.getByRole('row')).toHaveCount(3) // header + two visits
    const mainRow = history.getByRole('row').filter({ has: page.locator(`a[href="/visits/${main.visit.id}"]`) })
    await expect(mainRow).toContainText('Checked out')
    await expect(mainRow).toContainText(departmentName)
    await expect(mainRow).toContainText(MAIN_PURPOSE)
    const history2 = await employee.api.visitorVisits(main.visit.visitor.id)
    expect(history2.items.map((visit) => visit.id).toSorted()).toEqual([main.visit.id, previous.visit.id].toSorted())
  })

  const expectPreviousUnchanged = async () => {
    const now = await employee.api.visit(previous.visit.id)
    expect(durableFields(now)).toEqual(durableFields(previous.visit))
    const row = await queryOne<{ status: string; updated_at: string; check_in_at: string | null; active_passes: number }>(
      `SELECT v.status, v.updated_at, v.check_in_at,
              (SELECT count(*) FROM visitor_passes p WHERE p.visit_id = v.id AND p.revoked_at IS NULL)::int AS active_passes
         FROM visits v WHERE v.id = ${uuid(previous.visit.id)}`,
    )
    expect(row).toMatchObject({ status: 'SCHEDULED', check_in_at: null, active_passes: 1 })
    expect(Date.parse(row.updated_at)).toBe(Date.parse(previous.visit.updated_at))
  }

  await test.step('§40 step 26: the earlier visit of Hamad Raouf is unchanged', async () => {
    await expectPreviousUnchanged()
    const page = employee.page
    const previousRow = page.getByRole('table', { name: 'Visit history' }).getByRole('row').filter({ has: page.locator(`a[href="/visits/${previous.visit.id}"]`) })
    await expect(previousRow).toContainText('Scheduled')
    await expect(previousRow).toContainText(PREVIOUS_PURPOSE)
  })

  await test.step('§40 step 27: the audit log (admin UI) contains every relevant event', async () => {
    const page = admin.page
    await expectAuditEvents(page, `entity_type=department&entity_id=${department.id}`, ['Department created'])
    await expectAuditEvents(page, `entity_type=user&entity_id=${employeeUser.id}`, ['User created', 'Password changed'])
    await expectAuditEvents(page, `entity_type=user&entity_id=${receptionistUser.id}`, ['User created', 'Password changed'])
    await expectAuditEvents(page, `action=AUTH_LOGIN_SUCCEEDED&actor=${employeeUser.id}`, ['Signed in'])
    await expectAuditEvents(page, `action=AUTH_LOGIN_SUCCEEDED&actor=${receptionistUser.id}`, ['Signed in'])
    await expectAuditEvents(page, `entity_type=visitor&entity_id=${main.visit.visitor.id}`, ['Visitor created'])
    await expectAuditEvents(page, `entity_type=visit&entity_id=${previous.visit.id}`, ['Visit created'])
    await expectAuditEvents(page, `entity_type=visit&entity_id=${main.visit.id}`, [
      'Visit created',
      'Invitation queued',
      'Invitation sent',
      'Visitor pass scanned',
      'Visitor checked in',
      'Visitor checked out',
    ])
    await expectAuditEvents(page, `action=PASS_ISSUED&actor=${employeeUser.id}`, ['Visitor pass issued'])
    await expectAuditEvents(page, `action=PASS_REVOKED&actor=${receptionistUser.id}`, ['Visitor pass revoked'])

    // The same events through the API, with their metadata: what happened, never personal data (§3.2-8).
    const visitEvents = await adminApi.auditLogs({ entity_type: 'visit', entity_id: main.visit.id })
    const byAction = (action: string) => visitEvents.filter((event) => event.action === action)
    expect(byAction('VISIT_CREATED')).toHaveLength(1)
    expect(byAction('PASS_SCANNED').map((event) => event.metadata.outcome)).toEqual(['READY'])
    expect(byAction('VISIT_CHECKED_IN')).toEqual([expect.objectContaining({ actor: { id: receptionistUser.id, full_name: receptionistInput.name } })])
    expect(byAction('VISIT_CHECKED_OUT')).toEqual([expect.objectContaining({ actor: { id: receptionistUser.id, full_name: receptionistInput.name } })])
    const passEvents = [
      ...(await adminApi.auditLogs({ action: 'PASS_ISSUED', actor_user_id: employeeUser.id })),
      ...(await adminApi.auditLogs({ action: 'PASS_REVOKED', actor_user_id: receptionistUser.id })),
    ]
    expect(passEvents.filter((event) => event.metadata.visit_id === main.visit.id).map((event) => event.action).toSorted()).toEqual(['PASS_ISSUED', 'PASS_REVOKED'])
    const forbidden = [VISITOR.name, 'Hamad', visitorEmail, VISITOR.phone, MAIN_PURPOSE, passToken(main.pass_url), employeePassword, employeeTemporary]
    const all: AuditLog[] = [...visitEvents, ...passEvents]
    for (const event of all) {
      const metadata = JSON.stringify(event.metadata)
      for (const value of forbidden) expect(metadata, `${event.action} metadata`).not.toContain(value)
    }
  })

  await test.step('§40 step 28: unauthorised users cannot reach restricted information', async () => {
    // Another employee: the visit and its visitor do not exist for them (404, no existence oracle).
    const employeeB = await open({ as: 'employeeB' })
    await employeeB.page.goto(`/visits/${main.visit.id}`)
    await expect(employeeB.page.getByRole('heading', { level: 1, name: 'Visit not found' })).toBeVisible()
    await expect(employeeB.page.getByText(VISITOR.name)).toHaveCount(0)
    expect((await employeeB.api.fails('GET', `/visits/${main.visit.id}`, 404)).error.code).toBe('NOT_FOUND')
    await employeeB.api.fails('GET', `/visitors/${main.visit.visitor.id}`, 404)
    expect((await employeeB.api.ok<{ total: number }>('GET', '/visitors?q=Hamad')).total).toBe(0)

    // Management reads but cannot change anything.
    const management = await open({ as: 'management' })
    await management.page.goto(`/visits/${previous.visit.id}`)
    await expect(management.page.getByRole('heading', { level: 1, name: VISITOR.name })).toBeVisible()
    for (const action of ['Edit or reschedule', 'Cancel visit', 'Resend invitation', 'Send invitation']) {
      await expect(management.page.getByRole('button', { name: action })).toHaveCount(0)
    }
    for (const [method, path, body] of [
      ['POST', `/visits/${previous.visit.id}/cancel`, { reason: 'Not allowed' }],
      ['PATCH', `/visits/${previous.visit.id}`, { purpose: 'Changed by management' }],
      ['POST', `/visits/${previous.visit.id}/invitation`, undefined],
      ['POST', `/visits/${previous.visit.id}/check-in`, { method: 'MANUAL' }],
      ['POST', '/reception/scan', { token: passToken(previous.pass_url) }],
    ] as const) {
      expect((await management.api.fails(method, path, 403, body)).error.code, `${method} ${path}`).toBe('FORBIDDEN')
    }
    await management.page.goto('/visits/new')
    await expect(management.page).toHaveURL(/\/reports$/)

    // The receptionist cannot open administration pages (the guard sends them to reception; the API refuses).
    for (const path of ['/admin', '/admin/users', '/admin/audit']) {
      await reception.page.goto(path)
      await expect(reception.page).toHaveURL(/\/reception$/)
    }
    await expect(reception.page.getByRole('heading', { level: 1, name: 'Users' })).toHaveCount(0)
    for (const path of ['/users', '/audit-logs', '/dashboard/admin']) {
      expect((await reception.api.fails('GET', path, 403)).error.code, path).toBe('FORBIDDEN')
    }

    // Another company sees nothing of Demo Company: not the visit, the visitor, nor their audit trail.
    const other = await open({ as: 'otherAdmin' })
    await other.page.goto(`/visits/${main.visit.id}`)
    await expect(other.page.getByRole('heading', { level: 1, name: 'Visit not found' })).toBeVisible()
    await other.page.goto(`/visitors/${main.visit.visitor.id}`)
    await expect(other.page.getByRole('heading', { level: 1, name: 'Visitor not found' })).toBeVisible()
    await other.api.fails('GET', `/visits/${main.visit.id}`, 404)
    await other.api.fails('GET', `/visitors/${main.visit.visitor.id}`, 404)
    expect((await other.api.ok<{ total: number }>('GET', '/visitors?q=Hamad')).total).toBe(0)
    expect((await other.api.ok<{ total: number }>('GET', `/visits?scope=all&q=Hamad`)).total).toBe(0)
    expect(await other.api.auditLogs({ entity_id: main.visit.id })).toEqual([])
    // Its reception cannot use a Demo Company pass: the same answer as an unknown pass (§6 row 1).
    const otherReception = await apiAs('otherReception')
    const scan = await otherReception.fails('POST', '/reception/scan', 404, { token: passToken(previous.pass_url) })
    expect(scan.error.code).toBe('PASS_INVALID')

    // None of this changed the earlier visit.
    await expectPreviousUnchanged()
  })
})
