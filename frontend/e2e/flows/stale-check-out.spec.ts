import type { Visit } from '../../src/types/api.ts'
import type { Api } from '../support/api.ts'
import { timeTravel } from '../support/cli.ts'
import { expect, test } from '../support/fixtures.ts'
import { minutes } from '../support/time.ts'
import { uniqueTag, waitForApi } from '../support/ui.ts'

/*
 * Visitors who left without checking out (§5, §10 Inside tab): visits checked in on an earlier
 * company-local day are flagged and checked out in bulk with a reason (method BULK, check-out at
 * the scheduled end or the check-in, whichever is later). A visit checked in today is left alone.
 * Only this spec makes Demo Company visits stale, so the bulk action touches nothing of other specs.
 */

async function checkedInVisit(host: Api, reception: Api, name: string): Promise<Visit> {
  const now = Date.now()
  const created = await host.createVisit({ visitor: { full_name: name }, start: new Date(now - minutes(2)), end: new Date(now + minutes(58)) })
  return reception.checkIn(created.visit.id, { method: 'MANUAL' })
}

test('visitors still checked in from previous days are checked out in bulk with a reason', async ({ open, apiAs }) => {
  const tag = uniqueTag()
  const host = await apiAs('employee')
  const receptionApi = await apiAs('reception')
  const staleNames = [`Nadia Karim ${tag}`, `Yusuf Amari ${tag}`]
  const todayName = `Leila Haddad ${tag}`
  const stale = [await checkedInVisit(host, receptionApi, staleNames[0]!), await checkedInVisit(host, receptionApi, staleNames[1]!)]
  const today = await checkedInVisit(host, receptionApi, todayName)
  // 26 hours back: checked in on the previous company-local day, whatever the time now.
  for (const visit of stale) await timeTravel(visit.id, 26 * 60)
  for (const visit of stale) expect(await receptionApi.visit(visit.id)).toMatchObject({ status: 'CHECKED_IN', is_stale: true, is_overdue: true })
  expect((await receptionApi.visit(today.id)).is_stale).toBe(false)

  const { page } = await open({ as: 'reception' })
  await page.goto('/reception?tab=inside')
  await expect(page.getByText(/from previous days (is|are) still checked in/)).toBeVisible()
  const list = page.getByRole('list', { name: 'Visitors inside' })
  for (const name of staleNames) await expect(list.getByRole('listitem').filter({ hasText: name })).toContainText('Previous day')
  await page.getByRole('button', { name: 'Check out remaining from previous days' }).click()

  const dialog = page.getByRole('alertdialog', { name: 'Check out visitors from previous days' })
  for (const name of staleNames) await expect(dialog.getByText(name)).toBeVisible()
  await expect(dialog.getByText(todayName)).toHaveCount(0)
  const reason = 'Left without checking out (end-of-day sweep)'
  await dialog.getByRole('textbox', { name: 'Reason' }).fill(reason)
  const bulk = waitForApi(page, 'POST', '/reception/check-out-stale')
  await dialog.getByRole('button', { name: /^Check out \d+ visitors?$/ }).click()
  const response = await bulk
  expect(response.status()).toBe(200)
  expect(response.request().postDataJSON()).toEqual({ reason })
  const { checked_out: count } = (await response.json()) as { checked_out: number }
  expect(count).toBeGreaterThanOrEqual(2)
  await expect(page.getByText(`${count} visitors checked out`)).toBeVisible()
  for (const name of staleNames) await expect(list.getByRole('listitem').filter({ hasText: name })).toHaveCount(0)
  await expect(list.getByRole('listitem').filter({ hasText: todayName })).toHaveCount(1)

  for (const before of stale) {
    const after = await receptionApi.visit(before.id)
    expect(after).toMatchObject({ status: 'CHECKED_OUT', check_out_method: 'BULK', check_out_note: reason })
    const expected = Math.max(Date.parse(after.check_in_at ?? ''), Date.parse(after.scheduled_end))
    expect(Date.parse(after.check_out_at ?? '')).toBe(expected)
  }
  expect((await receptionApi.visit(today.id)).status).toBe('CHECKED_IN')
  const audit = await (await apiAs('admin')).auditLogs({ action: 'STALE_VISITS_CHECKED_OUT' })
  expect(audit.length).toBeGreaterThanOrEqual(1)
})
