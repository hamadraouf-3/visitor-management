import { expect, test } from '../support/fixtures.ts'
import { minutes } from '../support/time.ts'
import { resultText, scanPass, scanResult, uniqueTag, waitForApi } from '../support/ui.ts'

/*
 * The reception target of §10: from a scanned pass to "ready for the next visitor" in under 10 s,
 * at each viewport, through the handheld-scanner / paste input (the camera path is timed in
 * e2e/camera/camera-scan.spec.ts). The time covers the server's verdict, the check-in, the ≈1.5 s
 * success display and the return to "Ready to scan"; it is recorded as an annotation of the test.
 */

test('reception: scan → check-in → ready for the next visitor in under 10 s', async ({ open, apiAs }) => {
  const host = await apiAs('employee')
  const now = Date.now()
  const created = await host.createVisit({
    visitor: { full_name: `Timing Guest ${uniqueTag()}`, company_name: 'Swift Couriers' },
    start: new Date(now - minutes(2)),
    end: new Date(now + minutes(58)),
  })
  const { page } = await open({ as: 'reception' })
  await page.goto('/reception')
  await expect(resultText(page, 'Ready to scan')).toBeVisible()

  const startedAt = Date.now()
  const scan = await scanPass(page, created.pass_url)
  expect(scan.status()).toBe(200)
  const verdictAt = Date.now()
  await expect(resultText(page, 'Valid pass – ready to check in')).toBeVisible()
  const checkIn = waitForApi(page, 'POST', `/visits/${created.visit.id}/check-in`)
  await scanResult(page).getByRole('button', { name: 'Check in', exact: true }).click()
  expect((await checkIn).status()).toBe(200)
  await expect(resultText(page, 'Checked in')).toBeVisible()
  await expect(resultText(page, 'Ready to scan')).toBeVisible()
  const elapsed = Date.now() - startedAt

  const viewport = page.viewportSize()!
  test.info().annotations.push(
    { type: 'timing', description: `scan → check-in → ready at ${viewport.width} × ${viewport.height}: ${(elapsed / 1000).toFixed(2)} s` },
    { type: 'timing', description: `server verdict on the scan: ${verdictAt - startedAt} ms (input to response)` },
  )
  expect(elapsed).toBeLessThan(10_000)
})
