import { i18n } from '../../i18n'
import { formatCount } from '../../utils/number'

const t = i18n.getFixedT(null, 'reports')

/** "12 visits", in the UI language (a chart's values and the summaries). */
export const visits = (count: number) => t('units.visits', { count, formatted: formatCount(count) })

/** "12 check-ins", in the UI language. */
export const checkIns = (count: number) => t('units.checkIns', { count, formatted: formatCount(count) })
