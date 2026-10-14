import { getErrorMessage } from '../../api/client'
import { i18n } from '../../i18n'
import { insideFlags } from '../visits/insideFlags'
import { outcomeVisit, type FlowState } from './scanFlow'
import { isRecentCheckIn, refusalGuidance, scanNotices } from './scanOutcome'

/**
 * One sentence for the scanner's live region (§10 "aria-live scan results"): what just
 * happened, short enough to be read in full each time. The panel shows the details. The
 * wording stays fixed while a result is shown (no "starts in 10m"), so the region does not
 * speak again every minute.
 */
const t = i18n.getFixedT(null, 'reception')

export function scanAnnouncement(flow: FlowState, now: number, timeZone: string): string {
  switch (flow.step) {
    case 'ready':
      return ''
    case 'validating':
      return t('scan.checking')
    case 'acting': {
      const name = outcomeVisit(flow.outcome)?.visitor.full_name ?? t('scan.theVisitor')
      return flow.action.type === 'check-in' ? t('scan.announce.checkingIn', { name }) : t('scan.announce.checkingOut', { name })
    }
    case 'success': {
      const name = flow.visit.visitor.full_name
      return flow.completed === 'checked-in' ? t('scan.announce.checkedIn', { name }) : t('scan.announce.checkedOut', { name })
    }
    case 'result': {
      if (flow.actionError) return getErrorMessage(flow.actionError)
      const { outcome } = flow
      switch (outcome.kind) {
        case 'ready': {
          const notices = scanNotices(outcome, now, timeZone).map((notice) => ` ${notice.spoken}`)
          return `${t('scan.announce.ready', { name: outcome.visit.visitor.full_name })}${notices.join('')}`
        }
        case 'inside': {
          const name = outcome.visit.visitor.full_name
          if (isRecentCheckIn(outcome.visit, now)) return t('scan.announce.insideRecent', { name })
          const flags = insideFlags(outcome.visit, timeZone, now).map((flag) => ` ${flag.label}.`)
          const notices = scanNotices(outcome, now, timeZone).map((notice) => ` ${notice.spoken}`)
          return `${t('scan.announce.inside', { name })}${flags.join('')}${notices.join('')}`
        }
        // The verdict's title, as the panel shows it (the server's message only restated it).
        case 'refused':
          return refusalGuidance(outcome, now, timeZone).title ?? outcome.message
        case 'invalid':
          return outcome.message
        case 'failed':
          return getErrorMessage(outcome.error)
      }
    }
  }
}
