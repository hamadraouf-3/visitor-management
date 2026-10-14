import type { Tone } from '../../components/ui/tones'
import { i18n } from '../../i18n'
import { departmentSearchNames } from '../../i18n/departmentName'
import type { Visit, VisitorSearchItem } from '../../types/api'
import { formatTime, formatTimeOnDay } from '../../utils/datetime'
import { formatAgo, formatDuration, formatDurationInText, secondsBetween } from '../../utils/duration'
import { foldText } from '../../utils/text'

const t = i18n.getFixedT(null, 'reception')

/**
 * Which check-in a visit in a reception list offers. The server decides whether a check-in is
 * possible at all (`permissions.can_check_in`, B24-30); inside the pass window it is MANUAL
 * (after an ID check), outside it (same company-local day, or a no-show) it is an OVERRIDE with
 * a reason. The window is checked against `now`, because the list may be up to 15 s old.
 */
export type ListCheckIn = 'manual' | 'override'

export function listCheckIn(visit: Visit, now: number): ListCheckIn | null {
  if (!visit.permissions.can_check_in) return null
  const inWindow = visit.status === 'SCHEDULED' && now >= Date.parse(visit.window_start) && now <= Date.parse(visit.window_end)
  return inWindow ? 'manual' : 'override'
}

export function listCanCheckOut(visit: Visit): boolean {
  return visit.status === 'CHECKED_IN' && visit.permissions.can_check_out
}

export interface ArrivalStatus {
  label: string
  tone: Tone
}

/** Where an expected visitor stands relative to their pass window and scheduled time, in words. */
export function arrivalStatus(visit: Visit, now: number, timeZone: string): ArrivalStatus {
  const windowStart = Date.parse(visit.window_start)
  const windowEnd = Date.parse(visit.window_end)
  if (visit.status === 'NO_SHOW') return { label: t('arrival.noShow', { time: formatTime(windowEnd, timeZone) }), tone: 'warning' }
  if (now < windowStart) return { label: t('arrival.validFrom', { time: formatTime(windowStart, timeZone) }), tone: 'neutral' }
  if (now < Date.parse(visit.scheduled_start)) return { label: t('arrival.due', { time: formatTime(visit.scheduled_start, timeZone) }), tone: 'info' }
  if (now <= Date.parse(visit.scheduled_end)) return { label: t('arrival.now'), tone: 'success' }
  if (now <= windowEnd) return { label: t('arrival.late', { time: formatTime(windowEnd, timeZone) }), tone: 'warning' }
  return { label: t('arrival.expired', { time: formatTime(windowEnd, timeZone) }), tone: 'warning' }
}

/** Why a visit needs "Check in anyway", for the override dialog. */
export function overrideContext(visit: Visit, now: number, timeZone: string): string {
  const windowEnd = Date.parse(visit.window_end)
  if (visit.status === 'NO_SHOW' || now > windowEnd) return t('override.contextExpired', { time: formatTime(windowEnd, timeZone) })
  if (now < Date.parse(visit.window_start)) return t('override.contextNotYet', { time: formatTime(visit.window_start, timeZone) })
  return t('override.contextOther')
}

/** How long ago the visitor was checked in, as a phrase: "3m ago" · «قبل 3 د», «قبل أقل من دقيقة». */
export function checkedInAgo(visit: Visit, now: number): string {
  return visit.check_in_at ? formatAgo(secondsBetween(visit.check_in_at, now)) : formatDuration(null)
}

/** "1h 13m" since the check-in, for a sentence («منذ أقل من دقيقة في الداخل» under a minute). */
export function timeInside(visit: Visit, now: number): string {
  // A visitor who left was inside until the check-out, not until now.
  return visit.check_in_at ? formatDurationInText(secondsBetween(visit.check_in_at, visit.check_out_at ?? now)) : '—'
}

/**
 * "10:51 · 2h 2m inside" (the date too for an earlier day): when the visitor came in and how
 * long they have been inside, worded once for every reception surface. For a visitor who has
 * left (a refused scan of a completed visit, the visitor search): "09:02 · out 10:15".
 */
export function checkInTimeAndStay(visit: Visit, now: number, timeZone: string): string {
  if (!visit.check_in_at) return '—'
  const time = formatTimeOnDay(visit.check_in_at, now, timeZone)
  if (visit.check_out_at) return t('inside.timeAndOut', { time, out: formatTimeOnDay(visit.check_out_at, now, timeZone) })
  return t('inside.timeAndStay', { time, stay: timeInside(visit, now) })
}

/**
 * "Checked in 10:51 · 2h 2m inside": the check-in time of a visitor inside in the reception
 * lists and the visitor search ("In 10:51" read like "in ten minutes"). The history keeps its
 * "In … · Out …", where the check-in is paired with the check-out.
 */
export function checkedInLabel(visit: Visit, now: number, timeZone: string): string {
  return t('inside.checkedInLabel', { when: checkInTimeAndStay(visit, now, timeZone) })
}

/**
 * The inline filter of the Expected and Inside tabs: visitor, company, host, department (either of its
 * names) and purpose, ignoring case and accents.
 */
export function matchesVisitFilter(visit: Visit, filter: string): boolean {
  const needle = foldText(filter.trim())
  if (!needle) return true
  const departmentNames = visit.department ? departmentSearchNames(visit.department) : []
  const haystack = [visit.visitor.full_name, visit.visitor.company_name, visit.host.full_name, ...departmentNames, visit.purpose]
    .filter((part): part is string => Boolean(part))
    .map(foldText)
  return haystack.some((part) => part.includes(needle))
}

/**
 * The Expected tab's groups: "arriving" while the pass is valid, or the visitor is late (the
 * window ended moments ago and the server has not marked the visit a no-show yet); "later"
 * while the pass is not valid yet.
 */
export type ExpectedGroup = 'arriving' | 'later'

export function expectedGroup(visit: Pick<Visit, 'window_start'>, now: number): ExpectedGroup {
  return now < Date.parse(visit.window_start) ? 'later' : 'arriving'
}

/**
 * The one action a visit offers in a reception list row (Expected, Find a visitor), so both
 * lists follow one rule:
 * - `check-out`: the visitor is inside.
 * - `manual`: "Verify ID & check in", inside the pass window.
 * - `override`: "Check in anyway…" for a visitor who is late, or a no-show today.
 * - `override-in-menu`: the pass is not valid yet. An early check-in is the audited
 *   exception, so it waits in the row's menu instead of a button on every later row.
 * - `walk-in`: the server will not check the visit in (its host is no longer active).
 * - null: nothing (a visitor inside whom this user may not check out).
 */
export type RowAction = 'check-out' | 'manual' | 'override' | 'override-in-menu' | 'walk-in'

export function rowAction(visit: Visit, now: number): RowAction | null {
  if (visit.status === 'CHECKED_IN') return listCanCheckOut(visit) ? 'check-out' : null
  const checkIn = listCheckIn(visit, now)
  if (checkIn === 'manual') return 'manual'
  if (checkIn === 'override') return visit.status === 'SCHEDULED' && expectedGroup(visit, now) === 'later' ? 'override-in-menu' : 'override'
  return 'walk-in'
}

/** Inside first, then by scheduled start (ties by id, so the order never flips between refreshes). */
function compareTodayVisits(a: Visit, b: Visit): number {
  const inside = Number(b.status === 'CHECKED_IN') - Number(a.status === 'CHECKED_IN')
  return inside || Date.parse(a.scheduled_start) - Date.parse(b.scheduled_start) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

/** 0: someone inside; 1: expected today; 2: nothing to act on today. */
function searchRank(item: VisitorSearchItem): number {
  if (item.today_visits.some((visit) => visit.status === 'CHECKED_IN')) return 0
  return item.today_visits.length > 0 ? 1 : 2
}

/**
 * Adds today's no-shows (GET /reception/today `no_show`) to the visits of each visitor "Find a
 * visitor" found. The search's `today_visits` holds only SCHEDULED-today and CHECKED_IN visits
 * (B24-11), but a visitor whose visit today has become NO_SHOW is the typical late arrival, who
 * can still be checked in anyway that day (§5, D-08). Without this the search said "No visit to
 * check in or out today" and offered only a walk-in, which left the invited visit a no-show and
 * counted the person twice.
 */
export function withTodayNoShows(items: readonly VisitorSearchItem[], noShows: readonly Visit[]): VisitorSearchItem[] {
  return items.map((item) => {
    const known = new Set(item.today_visits.map((visit) => visit.id))
    const late: Visit[] = []
    for (const visit of noShows) {
      if (visit.visitor.id !== item.id || known.has(visit.id)) continue
      known.add(visit.id)
      late.push(visit)
    }
    return late.length > 0 ? { ...item, today_visits: [...item.today_visits, ...late] } : item
  })
}

/**
 * "Find a visitor" lists the visitors reception can act on first: whoever is inside, then
 * whoever is expected today by start time, then the rest in the server's (alphabetical)
 * order. Each visitor's own visits follow the same order. The server answers a page sorted by
 * name, so a common surname would otherwise put four visitors with nothing to do today, each
 * with a walk-in button, above the one who is arriving.
 */
export function orderSearchResults(items: readonly VisitorSearchItem[]): VisitorSearchItem[] {
  return items
    .map((item) => ({ ...item, today_visits: item.today_visits.toSorted(compareTodayVisits) }))
    .toSorted((a, b) => {
      const byRank = searchRank(a) - searchRank(b)
      if (byRank !== 0 || searchRank(a) === 2) return byRank
      const [first] = a.today_visits
      const [second] = b.today_visits
      return first && second ? compareTodayVisits(first, second) : 0
    })
}

/**
 * Whether the bulk "Check out remaining from previous days" takes the visit (B57-71): checked
 * in before today and past its scheduled end, so a night visitor expected until the morning
 * stays on the evacuation list, and one the server lets reception check out.
 */
export function isBulkCheckOutCandidate(visit: Visit): boolean {
  return visit.is_stale && visit.is_overdue && listCanCheckOut(visit)
}

/**
 * The check-out time the bulk check-out records (B57-71): the scheduled end, or the check-in if
 * that was later. Never after now: for the bulk set (overdue visits) that bound never applies,
 * but the corrected check-out's default uses the same rule for a visit still under way.
 */
export function bulkCheckOutAt(visit: Pick<Visit, 'check_in_at' | 'scheduled_end'>, now: number): number {
  const scheduledEnd = Date.parse(visit.scheduled_end)
  const checkIn = visit.check_in_at ? Date.parse(visit.check_in_at) : scheduledEnd
  return Math.min(Math.max(checkIn, scheduledEnd), now)
}

/**
 * Who is expected next, for the scan panel while nothing is scanned: today's scheduled visits
 * whose pass has not expired (a late visitor is the likeliest to walk in), earliest first.
 */
export function nextArrivals(expected: readonly Visit[], now: number, limit: number): Visit[] {
  return expected
    .filter((visit) => visit.status === 'SCHEDULED' && Date.parse(visit.window_end) >= now)
    .toSorted((a, b) => Date.parse(a.scheduled_start) - Date.parse(b.scheduled_start) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, limit)
}
