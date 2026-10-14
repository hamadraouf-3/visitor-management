import { i18n } from '../../i18n'
import { lazyTexts } from '../../i18n/lazyTexts'

const t = i18n.getFixedT(null, 'reception')

/** The reception screen's tabs (§10), kept in the URL as `?tab=` (Scan, the default, is left out). */
export const RECEPTION_TABS = ['scan', 'expected', 'inside', 'walk-in'] as const

export type ReceptionTab = (typeof RECEPTION_TABS)[number]

export const DEFAULT_RECEPTION_TAB: ReceptionTab = 'scan'

export const RECEPTION_TAB_LABELS: Record<ReceptionTab, string> = lazyTexts({
  scan: () => t('tabs.scan'),
  expected: () => t('tabs.expected'),
  inside: () => t('tabs.inside'),
  'walk-in': () => t('tabs.walkIn'),
})

/** The `?tab=` value for a tab: null (no parameter) for the default. */
export function receptionTabParam(tab: ReceptionTab): string | null {
  return tab === DEFAULT_RECEPTION_TAB ? null : tab
}
