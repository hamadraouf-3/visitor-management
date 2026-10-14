import { i18n } from '../../i18n'
import { lazyTexts } from '../../i18n/lazyTexts'
import type { EmployeeDashboard, VisitListParams, VisitStatus } from '../../types/api'
import { companyToday, shiftDateKey, type DateInput } from '../../utils/datetime'

/** The tabs of "My visits" (§10), in display order; the value is kept in `?tab=`. */
export const MY_VISITS_TABS = ['today', 'upcoming', 'past', 'attention'] as const
export type MyVisitsTab = (typeof MY_VISITS_TABS)[number]
export const DEFAULT_MY_VISITS_TAB: MyVisitsTab = 'today'

export const MY_VISITS_PAGE_SIZE = 25

const t = i18n.getFixedT(null, 'visits')

export const MY_VISITS_TAB_LABELS: Record<MyVisitsTab, string> = lazyTexts({
  today: () => t('myVisits.tabs.today'),
  upcoming: () => t('myVisits.tabs.upcoming'),
  past: () => t('myVisits.tabs.past'),
  attention: () => t('myVisits.tabs.attention'),
})

/** Accessible names of the visit table under each tab. */
export const MY_VISITS_TABLE_CAPTIONS: Record<MyVisitsTab, string> = lazyTexts({
  today: () => t('myVisits.captions.today'),
  upcoming: () => t('myVisits.captions.upcoming'),
  past: () => t('myVisits.captions.past'),
  attention: () => t('myVisits.captions.attention'),
})

/**
 * The statuses the employee dashboard counts as "today" (B24-31: everything but CANCELLED).
 * The Today tab lists exactly this set by default, so its badge and its list agree.
 */
export const TODAY_STATUSES: readonly VisitStatus[] = ['SCHEDULED', 'CHECKED_IN', 'CHECKED_OUT', 'NO_SHOW']

/**
 * Which visits of a tab are listed (`?show=`). `default` is the set the tab's badge counts;
 * the other choices find what the default leaves out, chiefly cancelled visits, which would
 * otherwise only be reachable through the visitor's history.
 */
export type MyVisitsShow = 'default' | 'cancelled' | 'attended' | 'no-show'

export interface MyVisitsShowOption {
  value: MyVisitsShow
  label: string
}

/** An option whose label is read from the catalog when read. */
function showOption(value: MyVisitsShow, label: () => string): MyVisitsShowOption {
  return {
    value,
    get label() {
      return label()
    },
  }
}

export const MY_VISITS_SHOW_OPTIONS: Record<MyVisitsTab, readonly MyVisitsShowOption[]> = {
  today: [showOption('default', () => t('myVisits.show.allButCancelled')), showOption('cancelled', () => t('myVisits.show.cancelled'))],
  upcoming: [showOption('default', () => t('myVisits.show.scheduled')), showOption('cancelled', () => t('myVisits.show.cancelled'))],
  past: [
    showOption('default', () => t('myVisits.show.allStatuses')),
    showOption('attended', () => t('myVisits.show.attended')),
    showOption('no-show', () => t('myVisits.show.noShows')),
    showOption('cancelled', () => t('myVisits.show.cancelled')),
  ],
  // The server's needs-attention rule (§8.1) has no status choices.
  attention: [],
}

/** The `?show=` value if the tab offers it, else `default`. */
export function readShow(tab: MyVisitsTab, raw: string | null): MyVisitsShow {
  return MY_VISITS_SHOW_OPTIONS[tab].find((option) => option.value === raw)?.value ?? 'default'
}

/** The empty-list title for a search within a tab: "No past visits match “orbit”". */
export function searchEmptyTitle(tab: MyVisitsTab, q: string): string {
  return t(`myVisits.searchEmpty.${tab}`, { q })
}

/** The empty-list title for a status choice other than the tab's default. */
export function filteredEmptyTitle(tab: MyVisitsTab, show: Exclude<MyVisitsShow, 'default'>): string {
  if (tab === 'attention') return t('myVisits.filteredEmpty.attention')
  return t(`myVisits.filteredEmpty.${tab}.${show}`)
}

/** The dashboard count shown on each tab. Past has none (the dashboard counts the last 30 days only). */
export function tabCount(tab: MyVisitsTab, counts: EmployeeDashboard['counts'] | undefined): number | undefined {
  if (!counts) return undefined
  switch (tab) {
    case 'today':
      return counts.today
    case 'upcoming':
      return counts.upcoming
    case 'attention':
      return counts.needs_attention
    case 'past':
      return undefined
  }
}

export interface MyVisitsQuery {
  tab: MyVisitsTab
  show: MyVisitsShow
  /** Free-text search within the tab. */
  q: string
  page: number
}

function statusesFor(tab: MyVisitsTab, show: MyVisitsShow): readonly VisitStatus[] | undefined {
  if (show === 'cancelled') return ['CANCELLED']
  switch (tab) {
    case 'today':
      return TODAY_STATUSES
    case 'upcoming':
      return ['SCHEDULED']
    case 'past':
      if (show === 'attended') return ['CHECKED_IN', 'CHECKED_OUT']
      if (show === 'no-show') return ['NO_SHOW']
      return undefined
    case 'attention':
      return undefined
  }
}

/**
 * GET /visits filters for a tab. Days are company-local `YYYY-MM-DD` keys (§3.2-7), so the
 * split into today / upcoming / past follows the company's calendar, not the browser's.
 *
 * - Today: visits scheduled today, every status but CANCELLED (as the dashboard counts them), earliest first.
 * - Upcoming: SCHEDULED visits from tomorrow on, earliest first.
 * - Past: every visit scheduled before today, latest first.
 * - Needs attention: the server's `needs_attention` rule (§8.1), earliest first.
 * - `show` swaps the status set (e.g. the cancelled visits of the same days).
 *
 * `scope=mine` always: the page is "My visits" for administrators too, who otherwise read
 * every visit of the company.
 */
export function visitListParamsForTab(
  { tab, show, q, page }: MyVisitsQuery,
  timeZone: string,
  now: DateInput = Date.now(),
): VisitListParams {
  const today = companyToday(timeZone, now)
  const search = q.trim()
  const statuses = statusesFor(tab, show)
  const base: VisitListParams = {
    scope: 'mine',
    page,
    page_size: MY_VISITS_PAGE_SIZE,
    ...(search ? { q: search } : {}),
    ...(statuses ? { status: [...statuses] } : {}),
  }
  switch (tab) {
    case 'today':
      return { ...base, date_from: today, date_to: today, order: 'asc' }
    case 'upcoming':
      return { ...base, date_from: shiftDateKey(today, 1), order: 'asc' }
    case 'past':
      return { ...base, date_to: shiftDateKey(today, -1), order: 'desc' }
    case 'attention':
      return { ...base, needs_attention: true, order: 'asc' }
  }
}
