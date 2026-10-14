import { randomBytes } from 'node:crypto'
import type { ScanResult, Visit, VisitCreateResult } from '../../src/types/api.ts'
import { passToken, type Api, type ErrorEnvelope } from '../support/api.ts'
import { timeTravel } from '../support/cli.ts'
import { queryRows, uuid } from '../support/db.ts'
import { expect, test } from '../support/fixtures.ts'
import { inlineImages, waitForMessage } from '../support/outbox.ts'
import { decodeQrImage } from '../support/qr.ts'
import { localDate, minutes } from '../support/time.ts'
import { resultText, scanAnnouncement, scanPass, scanResult, uniqueTag, waitForApi } from '../support/ui.ts'

/*
 * What reception sees for every pass that cannot simply be checked in (contract §6, rows 1–9), with
 * the real API: an expired pass (time travel) checked in anyway, a cancelled visit, an invalid pass,
 * a pass replaced by a resend, a visitor already inside and a visit already completed. Visits are
 * set up through the API as the seeded employee; reception works in the UI (desktop, where the
 * handheld-scanner field is always shown).
 */

/** A visit whose pass is valid now (starts two minutes ago, one hour long). */
async function arrivingVisit(host: Api, name: string, extra: { email?: string; sendInvitation?: boolean } = {}): Promise<VisitCreateResult> {
  const now = Date.now()
  return host.createVisit({
    visitor: { full_name: name, company_name: 'Northwind Logistics', ...(extra.email ? { email: extra.email } : {}) },
    start: new Date(now - minutes(2)),
    end: new Date(now + minutes(58)),
    purpose: 'Equipment delivery briefing',
    sendInvitation: extra.sendInvitation ?? false,
  })
}

async function errorOf(response: { status(): number; json(): Promise<unknown> }, status: number): Promise<ErrorEnvelope> {
  expect(response.status()).toBe(status)
  return (await response.json()) as ErrorEnvelope
}

test.describe('reception: passes that cannot simply be checked in', () => {
  test('an expired pass is refused; on the same day reception checks the visitor in anyway with a reason', async ({ open, apiAs }) => {
    const tag = uniqueTag()
    const host = await apiAs('employee')
    const timeZone = (await host.me()).company.timezone
    const name = `Lena Fischer ${tag}`
    const now = Date.now()
    const created = await host.createVisit({
      visitor: { full_name: name },
      start: new Date(now + minutes(5)),
      end: new Date(now + minutes(20)),
      purpose: 'Contract signature',
    })
    // Move the visit back until its pass window (scheduled end + grace) closed two minutes ago.
    const shift = Math.ceil((Date.parse(created.visit.window_end) - now) / 60_000) + 2
    const output = await timeTravel(created.visit.id, shift)
    expect(output).toContain(`moved ${shift} minutes into the past`)
    const shifted = await host.visit(created.visit.id)
    expect(Date.parse(shifted.window_end)).toBeLessThan(Date.now())
    // Overrides are allowed on the company-local day of the visit only (§5, D-08).
    const sameDay = localDate(shifted.scheduled_start, timeZone) === localDate(Date.now(), timeZone)

    const { page } = await open({ as: 'reception' })
    await page.goto('/reception')
    const response = await scanPass(page, created.pass_url)
    const error = await errorOf(response, 410)
    expect(error.error.code).toBe('PASS_EXPIRED')
    expect((error.error.details as { check_in_options: string[] }).check_in_options).toEqual(sameDay ? ['OVERRIDE'] : [])

    const result = scanResult(page)
    // What happened, with when: the title alone (the server's message only restated it, decision 3).
    await expect(resultText(page, /^Pass expired (at|on) /)).toBeVisible()
    await expect(resultText(page, 'This visitor pass has expired.')).toHaveCount(0)
    // Announced to screen readers too (aria-live result, §10).
    await expect(scanAnnouncement(page)).toContainText(/^Pass expired (at|on) /)
    await expect(result.getByRole('heading', { name })).toBeVisible()
    await expect(result.getByRole('button', { name: 'Check in', exact: true })).toHaveCount(0)
    // Expiry made the unattended visit a no-show (§5).
    expect((await host.visit(created.visit.id)).status).toBe('NO_SHOW')

    if (!sameDay) {
      test.info().annotations.push({ type: 'note', description: 'Run within the first minutes after company-local midnight: the shifted visit is on the previous day, so no override is offered (asserted).' })
      await expect(result.getByRole('button', { name: 'Check in anyway…' })).toHaveCount(0)
      return
    }
    await result.getByRole('button', { name: 'Check in anyway…' }).click()
    const dialog = page.getByRole('dialog', { name: 'Check in anyway' })
    await expect(dialog.getByText(`Verify ID: ${name}`)).toBeVisible()
    const reason = 'Arrived late; host confirmed by phone'
    await dialog.getByRole('textbox', { name: 'Reason' }).fill(reason)
    const checkIn = waitForApi(page, 'POST', `/visits/${created.visit.id}/check-in`)
    await dialog.getByRole('button', { name: 'Check in anyway' }).click()
    const checkInResponse = await checkIn
    expect(checkInResponse.status()).toBe(200)
    expect(checkInResponse.request().postDataJSON()).toEqual({ method: 'OVERRIDE', reason })
    await expect(resultText(page, 'Checked in')).toBeVisible()
    const visit = await host.visit(created.visit.id)
    expect(visit).toMatchObject({ status: 'CHECKED_IN', check_in_method: 'OVERRIDE', check_in_note: reason })
  })

  test('a cancelled visit’s pass is refused, and the visitor was told by email', async ({ open, apiAs }) => {
    const tag = uniqueTag()
    const host = await apiAs('employee')
    const name = `Omar Saeed ${tag}`
    const email = `omar.saeed.${tag}@guest.test`
    const created = await arrivingVisit(host, name, { email, sendInvitation: true })
    await host.settledInvitation(created.visit.id)

    // The host cancels in the UI.
    const employee = await open({ as: 'employee' })
    await employee.page.goto(`/visits/${created.visit.id}`)
    await employee.page.getByRole('button', { name: 'Cancel visit' }).click()
    const dialog = employee.page.getByRole('alertdialog', { name: 'Cancel this visit?' })
    const reason = 'The meeting moved online'
    await dialog.getByRole('textbox', { name: /^Reason/ }).fill(reason)
    await expect(dialog.getByRole('checkbox', { name: 'Notify the visitor by email' })).toBeChecked()
    const cancel = waitForApi(employee.page, 'POST', `/visits/${created.visit.id}/cancel`)
    await dialog.getByRole('button', { name: 'Cancel visit' }).click()
    expect((await cancel).status()).toBe(200)
    await expect(employee.page.getByText('This visit was cancelled')).toBeVisible()
    const cancelled = await host.visit(created.visit.id)
    expect(cancelled).toMatchObject({ status: 'CANCELLED', cancellation_reason: reason, pass: { status: 'REVOKED', revoke_reason: 'VISIT_CANCELLED' } })
    const notice = await waitForMessage({ kind: 'VISIT_CANCELLED', to: email })
    expect(notice.text).toContain(reason)

    const { page } = await open({ as: 'reception' })
    await page.goto('/reception')
    const error = await errorOf(await scanPass(page, created.pass_url), 409)
    expect(error.error.code).toBe('VISIT_CANCELLED')
    const result = scanResult(page)
    await expect(resultText(page, /^Visit cancelled by /)).toBeVisible()
    await expect(resultText(page, 'This visit has been cancelled.')).toHaveCount(0)
    for (const action of ['Check in', 'Verify ID & check in', 'Check in anyway…']) {
      await expect(result.getByRole('button', { name: action, exact: true })).toHaveCount(0)
    }
    await expect(result.getByRole('button', { name: 'Register walk-in' })).toBeVisible()
  })

  test('an invalid pass is refused with the same answer as any unknown pass, and the attempt is audited', async ({ open, apiAs }) => {
    const admin = await apiAs('admin')
    const since = new Date(Date.now() - 1_000).toISOString()
    const { page } = await open({ as: 'reception' })
    await page.goto('/reception')
    const result = scanResult(page)
    const forged = randomBytes(32).toString('base64url')
    for (const input of [`http://127.0.0.1:5199/pass#${forged}`, 'not-a-visitor-pass']) {
      const error = await errorOf(await scanPass(page, input), 404)
      expect(error.error).toMatchObject({ code: 'PASS_INVALID', message: 'Invalid visitor pass.' })
      await expect(resultText(page, 'Invalid visitor pass.')).toBeVisible()
      await expect(scanAnnouncement(page)).toHaveText('Invalid visitor pass.')
      await expect(result.getByRole('heading', { level: 3 })).toHaveCount(0)
      await result.getByRole('button', { name: 'Scan next' }).click()
      await expect(resultText(page, 'Ready to scan')).toBeVisible()
    }
    const reception = await (await apiAs('reception')).me()
    const scans = (await admin.auditLogs({ action: 'PASS_SCANNED', actor_user_id: reception.user.id })).filter(
      (event) => event.created_at >= since && event.metadata.outcome === 'INVALID',
    )
    expect(scans.length).toBeGreaterThanOrEqual(2)
    for (const event of scans) {
      expect(event.entity_id).toBeNull()
      expect(JSON.stringify(event.metadata)).not.toContain(forged)
    }
  })

  test('after a resend the previous pass is replaced: reception gets an ID check for it, and the new pass works', async ({ open, apiAs }) => {
    const tag = uniqueTag()
    const host = await apiAs('employee')
    const name = `Maya Rahman ${tag}`
    const email = `maya.rahman.${tag}@guest.test`
    const created = await arrivingVisit(host, name, { email, sendInvitation: true })
    await host.settledInvitation(created.visit.id)

    const employee = await open({ as: 'employee' })
    await employee.page.goto(`/visits/${created.visit.id}`)
    await employee.page.getByRole('button', { name: 'Resend invitation' }).click()
    const dialog = employee.page.getByRole('alertdialog', { name: 'Resend the invitation?' })
    await expect(dialog.getByText('The previous QR code will stop working')).toBeVisible()
    const resend = waitForApi(employee.page, 'POST', `/visits/${created.visit.id}/invitation`)
    await dialog.getByRole('button', { name: 'Resend invitation' }).click()
    const response = await resend
    expect(response.status()).toBe(200)
    const newPassUrl = ((await response.json()) as VisitCreateResult).pass_url
    expect(newPassUrl).not.toBe(created.pass_url)
    await expect(employee.page.getByRole('heading', { name: 'New visitor pass' })).toBeVisible()
    await expect(employee.page.getByLabel('Pass link')).toHaveValue(newPassUrl)
    const message = await waitForMessage({ kind: 'VISITOR_INVITATION', to: email, where: (m) => m.pass_url === newPassUrl })
    expect(await decodeQrImage(inlineImages(message)[0]!.bytes)).toEqual([newPassUrl])
    const passes = await queryRows<{ revoke_reason: string | null }>(`SELECT revoke_reason FROM visitor_passes WHERE visit_id = ${uuid(created.visit.id)} ORDER BY created_at`)
    expect(passes).toEqual([{ revoke_reason: 'ROTATED' }, { revoke_reason: null }])

    const { page } = await open({ as: 'reception' })
    await page.goto('/reception')
    const result = scanResult(page)
    const error = await errorOf(await scanPass(page, created.pass_url), 410)
    expect(error.error.code).toBe('PASS_REVOKED')
    expect((error.error.details as { check_in_options: string[] }).check_in_options).toEqual(['MANUAL'])
    await expect(resultText(page, /^Pass replaced (at|on) /)).toBeVisible()
    await expect(resultText(page, /This visitor pass has been replaced/)).toHaveCount(0)
    await expect(result.getByRole('button', { name: 'Verify ID & check in' })).toBeVisible()
    await result.getByRole('button', { name: 'Scan next' }).click()

    const ready = await scanPass(page, newPassUrl)
    expect(ready.status()).toBe(200)
    expect(((await ready.json()) as ScanResult).result).toBe('READY')
    const checkIn = waitForApi(page, 'POST', `/visits/${created.visit.id}/check-in`)
    await result.getByRole('button', { name: 'Check in', exact: true }).click()
    expect((await checkIn).status()).toBe(200)
    await expect(resultText(page, 'Checked in')).toBeVisible()
    expect(await host.visit(created.visit.id)).toMatchObject({ status: 'CHECKED_IN', check_in_method: 'QR' })
  })

  test('a visitor already inside: the scan says so and offers check-out (with a confirmation so soon after check-in)', async ({ open, apiAs }) => {
    const host = await apiAs('employee')
    const receptionApi = await apiAs('reception')
    const name = `Sami Haddad ${uniqueTag()}`
    const created = await arrivingVisit(host, name)
    await receptionApi.checkIn(created.visit.id, { method: 'QR', pass_token: passToken(created.pass_url) })

    const { page } = await open({ as: 'reception' })
    await page.goto('/reception')
    const response = await scanPass(page, created.pass_url)
    expect(response.status()).toBe(200)
    expect((await response.json()) as ScanResult).toMatchObject({ result: 'ALREADY_CHECKED_IN', actions: { check_in: false, check_out: true } })
    const result = scanResult(page)
    await expect(resultText(page, /^Already checked in at /)).toBeVisible()
    await expect(result.getByRole('heading', { name })).toBeVisible()
    await expect(result.getByRole('button', { name: 'Check in', exact: true })).toHaveCount(0)
    // Checked in less than 5 minutes ago: the check-out is secondary and asks first (§10).
    await result.getByRole('button', { name: 'Check out…' }).click()
    const confirm = page.getByRole('dialog', { name: `Check out ${name}?` })
    await expect(confirm).toBeVisible()
    await confirm.getByRole('button', { name: 'Cancel' }).click()
    await expect(confirm).toBeHidden()
    expect((await host.visit(created.visit.id)).status).toBe('CHECKED_IN')
  })

  test('a completed visit’s pass is refused; re-entry is a new walk-in', async ({ open, apiAs }) => {
    const host = await apiAs('employee')
    const receptionApi = await apiAs('reception')
    const name = `Rania Aziz ${uniqueTag()}`
    const created = await arrivingVisit(host, name)
    await receptionApi.checkIn(created.visit.id, { method: 'MANUAL' })
    const out: Visit = await receptionApi.checkOut(created.visit.id, { method: 'MANUAL' })
    expect(out.status).toBe('CHECKED_OUT')

    const { page } = await open({ as: 'reception' })
    await page.goto('/reception')
    const error = await errorOf(await scanPass(page, created.pass_url), 409)
    expect(error.error.code).toBe('VISIT_COMPLETED')
    const result = scanResult(page)
    await expect(resultText(page, /^Checked out at /)).toBeVisible()
    await expect(resultText(page, 'This visit has already been completed.')).toHaveCount(0)
    await expect(result.getByRole('button', { name: 'Check in', exact: true })).toHaveCount(0)
    await expect(result.getByRole('button', { name: 'Register walk-in' })).toBeVisible()
    expect((await host.visit(created.visit.id)).status).toBe('CHECKED_OUT')
  })
})
