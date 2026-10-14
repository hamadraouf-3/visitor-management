import type { Visit } from '../../types/api'

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })

/**
 * Everyone inside, by visitor name (then host), the order a roll call reads them in. Ties keep
 * a stable order by visit id, so rows do not swap places between refreshes.
 */
export function sortForRollCall<T extends Visit>(visits: readonly T[]): T[] {
  return visits.toSorted(
    (a, b) =>
      collator.compare(a.visitor.full_name, b.visitor.full_name) ||
      collator.compare(a.host.full_name, b.host.full_name) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  )
}

export interface InsideSummary {
  headcount: number
  overdue: number
  /** Checked in before today (company-local) and never checked out. */
  previousDays: number
}

/**
 * Counts for the summary. The headcount is the server's `count` (exact), which may exceed the
 * rows if the server ever caps the list; the flags are counted over the rows.
 */
export function insideSummary(count: number, visits: readonly Visit[]): InsideSummary {
  return {
    headcount: count,
    overdue: visits.filter((visit) => visit.is_overdue).length,
    previousDays: visits.filter((visit) => visit.is_stale).length,
  }
}
