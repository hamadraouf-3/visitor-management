import { expect, type Page } from '@playwright/test'

/*
 * What a tap hits on the evacuation list (/inside), measured on screen with elementFromPoint, the
 * way a touch lands: the visitor's name (the link to the visit; in a card its hit area is the whole
 * card) and the visitor's phone link under it (its touch area reaches 12 px up, see PhoneLink).
 * Audit finding: in a card without a company line the phone took the lower 8 px of the name, and a
 * tap there dialled the visitor instead of opening the visit; the name's band was 30 px tall.
 */

export interface VisitorTargets {
  name: string
  hasCompany: boolean
  /** Pixel rows of the name's text (every line) where a tap does not open the visit. */
  nameRowsLost: number
  nameRows: number
  /** The run of points, through the name from top to bottom, where a tap opens the visit (px). */
  nameBand: number
  /** Lines of the name, and the height of the name and company block. */
  nameLines: number
  linesHeight: number
  phone: {
    width: number
    height: number
    /** Pixel rows of the phone link's box where a tap does not dial. */
    rowsElsewhere: number
    /** How far the phone link's box overlaps the name's text (px, 0 = apart). */
    overlap: number
    /** From the top of the name to the top of the phone's line (px). */
    offsetFromName: number
    /** From the bottom of the name and company block to the top of the phone's line (px). */
    gapBelowLines: number
  } | null
}

/** Every row of the evacuation list, each scrolled to the middle of the screen while it is measured. */
export function measureVisitorTargets(page: Page): Promise<VisitorTargets[]> {
  return page.getByRole('table', { name: 'Visitors inside now' }).evaluate((table) => {
    const linkAt = (x: number, y: number) => table.ownerDocument.elementFromPoint(x, y)?.closest('a') ?? null
    const results: VisitorTargets[] = []
    for (const row of Array.from(table.querySelectorAll('tbody tr'))) {
      const name = row.querySelector<HTMLAnchorElement>('a[data-row-link]')
      if (!name) continue
      row.scrollIntoView({ block: 'center' })
      const lines = name.parentElement as HTMLElement
      const rects = Array.from(name.getClientRects())
      let nameRows = 0
      let nameRowsLost = 0
      for (const rect of rects) {
        for (let y = Math.ceil(rect.top) + 0.5; y < rect.bottom; y += 1) {
          nameRows += 1
          if ([rect.left + 1, rect.left + rect.width / 2, rect.right - 1].some((x) => linkAt(x, y) !== name)) nameRowsLost += 1
        }
      }
      const first = rects[0]!
      const x = first.left + Math.min(first.width / 2, 20)
      let top = first.top + first.height / 2
      let bottom = top
      while (top > 0 && linkAt(x, top - 1) === name) top -= 1
      while (bottom < innerHeight - 1 && linkAt(x, bottom + 1) === name) bottom += 1

      const phoneLine = row.querySelector<HTMLElement>('[data-visitor-phone]')
      const phoneLink = phoneLine?.querySelector<HTMLAnchorElement>('a[href^="tel:"]') ?? null
      let phone: VisitorTargets['phone'] = null
      if (phoneLine && phoneLink) {
        const box = phoneLink.getBoundingClientRect()
        let rowsElsewhere = 0
        for (let y = Math.ceil(box.top) + 0.5; y < box.bottom; y += 1) {
          if (linkAt(box.left + box.width / 2, y) !== phoneLink) rowsElsewhere += 1
        }
        const overlap = Math.max(
          0,
          ...rects.map((rect) =>
            rect.right > box.left && box.right > rect.left ? Math.min(rect.bottom, box.bottom) - Math.max(rect.top, box.top) : 0,
          ),
        )
        const lineTop = phoneLine.getBoundingClientRect().top
        phone = {
          width: box.width,
          height: box.height,
          rowsElsewhere,
          overlap,
          offsetFromName: lineTop - first.top,
          gapBelowLines: lineTop - lines.getBoundingClientRect().bottom,
        }
      }
      results.push({
        name: name.textContent ?? '',
        hasCompany: lines.querySelector('p') !== null,
        nameRowsLost,
        nameRows,
        nameBand: bottom - top + 1,
        nameLines: new Set(rects.map((rect) => Math.round(rect.top))).size,
        linesHeight: lines.getBoundingClientRect().height,
        phone,
      })
    }
    return results
  })
}

/**
 * Every pixel row of each visitor's name opens the visit and every pixel row of the phone link
 * dials; the two never overlap. On a touch screen the name keeps a band at least 44 px tall and
 * the phone link is at least 44 px tall (WCAG 2.5.5).
 */
export function expectSeparateVisitorTargets(rows: VisitorTargets[], { touch }: { touch: boolean }): void {
  expect(rows.length, 'rows measured').toBeGreaterThan(0)
  for (const row of rows) {
    const label = `${row.name}${row.hasCompany ? ' (with company)' : ''}`
    expect(row.nameRowsLost, `${label}: pixel rows of the name where a tap does not open the visit (of ${row.nameRows})`).toBe(0)
    if (touch) expect(row.nameBand, `${label}: height of the name link's band`).toBeGreaterThanOrEqual(44)
    if (!row.phone) continue
    expect(row.phone.overlap, `${label}: overlap of the phone link and the name`).toBeLessThanOrEqual(0)
    expect(row.phone.rowsElsewhere, `${label}: pixel rows of the phone link where a tap does not dial`).toBe(0)
    if (touch) {
      expect(row.phone.height, `${label}: height of the phone link`).toBeGreaterThanOrEqual(44)
      expect(row.phone.width, `${label}: width of the phone link`).toBeGreaterThanOrEqual(44)
    }
  }
}
