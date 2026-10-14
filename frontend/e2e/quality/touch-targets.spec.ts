import { storageStatePath, type AccountKey } from '../support/accounts.ts'
import { expect, test } from '../support/fixtures.ts'
import { expectSeparateVisitorTargets, measureVisitorTargets } from '../support/hit-targets.ts'
import { qualityData } from '../support/quality-data.ts'
import { afterFrames } from '../support/ui.ts'

/*
 * Touch targets on the evacuation list (/inside) with real data, for every role that sees it
 * (F9-9 and the re-audit's finding on the cards): a visitor's phone link never covers the name,
 * the link to the visit; on a touch screen the name keeps a band at least 44 px tall and the phone
 * link is 44 px tall. Measured as a tap lands (support/hit-targets.ts) on every row, the seeded
 * visitor with a phone and no company (the tightest cell) among them. The tablet project checks
 * its cards (820 × 1180) and the touch table (1180 × 820), the phone its cards (390 × 844) and the
 * desktop the table with a mouse. e2e/inside-touch-targets.spec.ts covers more widths and names
 * that wrap, with the API mocked.
 */

test.describe.configure({ mode: 'parallel' })

const VIEWPORTS: Record<string, { width: number; height: number }[]> = {
  desktop: [{ width: 1440, height: 900 }],
  tablet: [
    { width: 820, height: 1180 },
    { width: 1180, height: 820 },
  ],
  mobile: [{ width: 390, height: 844 }],
}

const ROLES: AccountKey[] = ['admin', 'reception', 'management']

for (const account of ROLES) {
  test.describe(account, () => {
    test.use({ storageState: storageStatePath(account) })
    test(`${account} · inside now: a visitor's phone never covers the name, the link to the visit`, async ({ page }, testInfo) => {
      const viewports = VIEWPORTS[testInfo.project.name]
      test.skip(!viewports, 'Runs in the desktop, tablet and phone projects')
      const { phoneOnlyVisitorName } = qualityData()
      await page.goto('/inside')
      await expect(page.getByRole('link', { name: phoneOnlyVisitorName, exact: true })).toBeVisible()
      await expect(page.locator('[role="status"] .animate-spin')).toHaveCount(0)
      const touch = await page.evaluate(() => matchMedia('(pointer: coarse)').matches)

      for (const viewport of viewports!) {
        await test.step(`${viewport.width} × ${viewport.height}`, async () => {
          await page.setViewportSize(viewport)
          await afterFrames(page, 2)
          const rows = await measureVisitorTargets(page)
          const tightest = rows.find((row) => row.name === phoneOnlyVisitorName)
          expect(tightest?.phone && !tightest.hasCompany, `${phoneOnlyVisitorName}: a phone and no company`).toBe(true)
          testInfo.annotations.push({
            type: 'touch targets',
            description: `${viewport.width}×${viewport.height}: ${rows.length} rows; ${phoneOnlyVisitorName}: name band ${tightest!.nameBand} px, ${tightest!.nameRowsLost}/${tightest!.nameRows} name rows lost, phone ${Math.round(tightest!.phone!.height)} px tall, overlap ${tightest!.phone!.overlap} px`,
          })
          expectSeparateVisitorTargets(rows, { touch })
        })
      }
    })
  })
}
