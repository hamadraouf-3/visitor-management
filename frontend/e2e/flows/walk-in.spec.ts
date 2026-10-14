import type { Visit } from '../../src/types/api.ts'
import { ACCOUNTS } from '../support/accounts.ts'
import { expect, test } from '../support/fixtures.ts'
import { waitForMessage } from '../support/outbox.ts'
import { minutes } from '../support/time.ts'
import { chooseRadio, pickFromCombobox, uniqueTag, waitForApi } from '../support/ui.ts'

/*
 * A walk-in end to end (D-07): reception registers a visitor without an invitation on the tablet,
 * the visitor is checked in at once, the host is emailed, the visitor is listed inside and is
 * checked out from the Inside tab.
 */

test('a walk-in is registered and checked in on the tablet, the host is notified, and the visitor is checked out', async ({ open, apiAs }) => {
  const tag = uniqueTag()
  const name = `Tariq Mansour ${tag}`
  const company = 'Blue Ridge Couriers'
  const purpose = `Parcel delivery for Finance ${tag}`
  const reception = await open({ as: 'reception', device: 'tablet' })
  const { page } = reception
  const admin = await apiAs('admin')

  await page.goto('/reception?tab=walk-in')
  await expect(page.getByRole('tab', { name: 'Walk-in' })).toHaveAttribute('aria-selected', 'true')
  await page.getByLabel('Full name').fill(name)
  await page.getByRole('button', { name: 'Add contact details (optional)' }).click()
  await page.getByLabel('Company (optional)').fill(company)
  await page.getByLabel('Phone (optional)').fill('+962 79 555 0190')
  await pickFromCombobox(page, 'Host', 'Omar', new RegExp(ACCOUNTS.employee.name))
  await page.getByLabel('Purpose').fill(purpose)
  await chooseRadio(page, '1 hour')
  await chooseRadio(page, 'Delivery')

  const registered = waitForApi(page, 'POST', '/reception/walk-ins')
  const startedAt = Date.now()
  await page.getByRole('button', { name: 'Check in walk-in' }).click()
  const response = await registered
  expect(response.status()).toBe(201)
  const visit = (await response.json()) as Visit
  await expect(page.getByText(`${name} checked in`)).toBeVisible()
  await expect(page.getByText('Registered as a walk-in.')).toBeVisible()
  // Back on the scanner for the next visitor.
  await expect(page.getByRole('tab', { name: /^Scan/ })).toHaveAttribute('aria-selected', 'true')

  const employee = await (await apiAs('employee')).me()
  expect(visit).toMatchObject({
    status: 'CHECKED_IN',
    is_walk_in: true,
    walk_in_reason: 'DELIVERY',
    check_in_method: 'WALK_IN',
    visitor: { full_name: name, company_name: company },
    host: { id: employee.user.id },
    department: { id: employee.user.department?.id },
    purpose,
  })
  const expectedEnd = Date.parse(visit.scheduled_end)
  expect(expectedEnd).toBeGreaterThanOrEqual(startedAt + minutes(60) - 5_000)
  expect(expectedEnd).toBeLessThanOrEqual(Date.now() + minutes(60) + 5_000)

  const arrival = await waitForMessage({ kind: 'HOST_ARRIVAL', to: ACCOUNTS.employee.email, where: (message) => message.text.includes(name) })
  expect(arrival.text).toContain(`Your visitor ${name} has arrived and checked in`)

  await page.getByRole('tab', { name: /^Inside/ }).click()
  const row = page.getByRole('list', { name: 'Visitors inside' }).getByRole('listitem').filter({ hasText: name })
  await expect(row).toHaveCount(1)
  await expect(row).toContainText(company)
  await expect(row).toContainText(`Host ${ACCOUNTS.employee.name}`)
  await row.getByRole('button', { name: 'Check out' }).click()
  const confirm = page.getByRole('dialog', { name: `Check out ${name}?` })
  const checkOut = waitForApi(page, 'POST', `/visits/${visit.id}/check-out`)
  await confirm.getByRole('button', { name: 'Check out' }).click()
  expect((await checkOut).status()).toBe(200)
  await expect(page.getByText(`${name} checked out`)).toBeVisible()
  await expect(row).toHaveCount(0)

  expect(await reception.api.visit(visit.id)).toMatchObject({ status: 'CHECKED_OUT', check_out_method: 'MANUAL' })
  const events = (await admin.auditLogs({ entity_type: 'visit', entity_id: visit.id })).map((event) => event.action)
  expect(events).toEqual(expect.arrayContaining(['WALK_IN_CREATED', 'VISIT_CHECKED_IN', 'VISIT_CHECKED_OUT']))
})
