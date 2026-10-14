import type { VisitCreateResult } from '../../src/types/api.ts'
import { passToken } from '../support/api.ts'
import { queryRows, uuid } from '../support/db.ts'
import { FAIL_DOMAIN } from '../support/env.ts'
import { expect, test } from '../support/fixtures.ts'
import { findMessages, inlineImages, waitForMessage } from '../support/outbox.ts'
import { decodeQrImage } from '../support/qr.ts'
import { minutes, nextQuarterHour } from '../support/time.ts'
import { setDateTime, uniqueTag, waitForApi } from '../support/ui.ts'

/*
 * Contract §9 and §11: an invitation that cannot be delivered never loses the visit. The outbox
 * provider fails every recipient at EMAIL_FAIL_DOMAIN (fail.test). The host sees the failure on the
 * success screen, corrects the address, and the invitation goes to the new address with a new pass
 * (D-19: the old pass is revoked).
 */

test('an undeliverable invitation keeps the visit; correcting the address resends it with a new pass', async ({ open, apiAs }) => {
  const tag = uniqueTag()
  const name = `Faris Nabil ${tag}`
  const badEmail = `visitor.${tag}@${FAIL_DOMAIN}`
  const goodEmail = `faris.nabil.${tag}@guest.test`
  const employee = await open({ as: 'employee' })
  const { page } = employee
  const timeZone = (await employee.api.me()).company.timezone
  const reception = await apiAs('reception')
  const admin = await apiAs('admin')

  await page.goto('/visits/new')
  await page.getByLabel('Full name').fill(name)
  await page.getByRole('textbox', { name: 'Email' }).fill(badEmail)
  const start = nextQuarterHour(timeZone)
  await setDateTime(page, 'Starts', start, timeZone)
  await setDateTime(page, 'Ends', new Date(start.getTime() + minutes(60)), timeZone)
  await page.getByLabel('Purpose').fill('Site inspection')
  const created = waitForApi(page, 'POST', '/visits')
  await page.getByRole('button', { name: 'Send invitation' }).click()
  const response = await created
  expect(response.status()).toBe(201)
  const result = (await response.json()) as VisitCreateResult
  const visitId = result.visit.id

  // The failure is shown where the host is, with the ways out (§10).
  await expect(page.getByText(`Invitation not delivered to ${badEmail}`)).toBeVisible({ timeout: 20_000 })
  const failed = await employee.api.settledInvitation(visitId)
  expect(failed).toMatchObject({ status: 'SCHEDULED', invitation: { status: 'FAILED', to_email: badEmail }, pass: { status: 'ACTIVE' } })
  const rows = await queryRows<{ status: string; attempts: number; last_error: string | null }>(
    `SELECT status, attempts, last_error FROM email_messages WHERE visit_id = ${uuid(visitId)} AND kind = 'VISITOR_INVITATION'`,
  )
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ status: 'FAILED', attempts: 1 })
  expect(rows[0]!.last_error).toBeTruthy()
  expect(findMessages({ kind: 'VISITOR_INVITATION', to: badEmail })).toEqual([])
  expect((await admin.auditLogs({ entity_type: 'visit', entity_id: visitId })).map((event) => event.action)).toContain('INVITATION_FAILED')
  // The visit is kept and its pass still works (the host could share the link instead).
  expect((await reception.scanReady(passToken(result.pass_url))).result).toBe('READY')

  await page.getByRole('button', { name: 'Correct email and resend' }).click()
  const dialog = page.getByRole('dialog', { name: 'Correct the email address' })
  await dialog.getByRole('textbox', { name: /^Email/ }).fill(goodEmail)
  const saved = waitForApi(page, 'PATCH', `/visitors/${result.visit.visitor.id}`)
  await dialog.getByRole('button', { name: 'Save and send invitation' }).click()
  expect((await saved).status()).toBe(200)
  await expect(dialog).toBeHidden()

  const resent = await employee.api.settledInvitation(visitId)
  expect(resent).toMatchObject({ id: visitId, status: 'SCHEDULED', invitation: { status: 'SENT', to_email: goodEmail }, pass: { status: 'ACTIVE' } })
  const message = await waitForMessage({ kind: 'VISITOR_INVITATION', to: goodEmail })
  expect(message.pass_url).not.toBeNull()
  expect(message.pass_url).not.toBe(result.pass_url)
  expect(await decodeQrImage(inlineImages(message)[0]!.bytes)).toEqual([message.pass_url])
  const passes = await queryRows<{ revoke_reason: string | null }>(`SELECT revoke_reason FROM visitor_passes WHERE visit_id = ${uuid(visitId)} ORDER BY created_at`)
  expect(passes).toEqual([{ revoke_reason: 'VISITOR_EMAIL_CHANGED' }, { revoke_reason: null }])

  // The old pass is replaced; the emailed one works.
  const old = await reception.fails('POST', '/reception/scan', 410, { token: passToken(result.pass_url) })
  expect(old.error.code).toBe('PASS_REVOKED')
  expect((await reception.scanReady(passToken(message.pass_url!))).visit.id).toBe(visitId)
  await page.goto(`/visits/${visitId}`)
  await expect(page.getByText(`Sent to ${goodEmail}`).first()).toBeVisible()
})
