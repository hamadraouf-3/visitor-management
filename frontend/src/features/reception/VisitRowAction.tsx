import { IdCard, LogIn, LogOut, UserPlus } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Badge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { ROW_ACTION_ATTRIBUTE } from '../../hooks/useListFocusRecovery'
import type { Visit } from '../../types/api'
import type { ListVisitAction } from './VisitActionDialog'
import { rowAction, type RowAction } from './visitActions'
import { VisitRow } from './VisitRow'
import type { WalkInPrefill } from './walkInForm'

const ROW_ACTION = { [ROW_ACTION_ATTRIBUTE]: '' }

interface VisitRowActionProps {
  visit: Visit
  kind: RowAction | null
  onAction: (action: ListVisitAction) => void
  onWalkIn: (prefill: WalkInPrefill) => void
}

/**
 * The visible action of a visit row (see `rowAction`), worded the same in every list. An early
 * check-in has no button: it is in the row's menu.
 */
export function VisitRowAction({ visit, kind, onAction, onWalkIn }: VisitRowActionProps) {
  const { t } = useTranslation('reception')
  switch (kind) {
    case 'manual':
      return (
        <Button size="lg" icon={<IdCard aria-hidden="true" />} onClick={() => onAction({ kind: 'check-in', method: 'MANUAL', visit })} {...ROW_ACTION}>
          {t('actions.verifyAndCheckIn')}
        </Button>
      )
    case 'override':
      return (
        <Button
          variant="secondary"
          size="lg"
          icon={<LogIn aria-hidden="true" className="mirror-rtl" />}
          onClick={() => onAction({ kind: 'check-in', method: 'OVERRIDE', visit })}
          {...ROW_ACTION}
        >
          {t('actions.checkInAnyway')}
        </Button>
      )
    case 'check-out':
      // Outlined, like the scan result's Check out: a list of check-ins never shows a check-out in their style.
      return (
        <Button variant="secondary" size="lg" icon={<LogOut aria-hidden="true" className="mirror-rtl" />} onClick={() => onAction({ kind: 'check-out', visit })} {...ROW_ACTION}>
          {t('actions.checkOut')}
        </Button>
      )
    case 'walk-in':
      return (
        <Button
          variant="secondary"
          size="lg"
          icon={<UserPlus aria-hidden="true" />}
          onClick={() => onWalkIn({ visitorId: visit.visitor.id, purpose: visit.purpose })}
          {...ROW_ACTION}
        >
          {t('actions.registerWalkIn')}
        </Button>
      )
    case 'override-in-menu':
    case null:
      return null
  }
}

export interface ActionVisitRowProps {
  visit: Visit
  now: number
  /** When: the scheduled time, or the check-in time. */
  when: ReactNode
  /** `when` is a bare time range (see VisitRow). */
  whenNumeric?: boolean
  /** The list's own badges (arrival state, status, inside flags). */
  badges?: ReactNode
  /** Leave the visitor's name out of the row (it is named above it). */
  showVisitor?: boolean
  onAction: (action: ListVisitAction) => void
  onWalkIn: (prefill: WalkInPrefill) => void
}

/**
 * A visit row of a reception list with the action `rowAction` gives it: the same button,
 * label and menu in Expected and in "Find a visitor". A visit the server will not check in
 * says so ("Check-in not available") and offers a walk-in instead.
 */
export function ActionVisitRow({ visit, now, when, whenNumeric, badges, showVisitor, onAction, onWalkIn }: ActionVisitRowProps) {
  const { t } = useTranslation('reception')
  const kind = rowAction(visit, now)
  return (
    <VisitRow
      visit={visit}
      when={when}
      whenNumeric={whenNumeric}
      showVisitor={showVisitor}
      inside={visit.status === 'CHECKED_IN'}
      badges={
        <>
          {badges}
          {kind === 'walk-in' && <Badge tone="danger">{t('checkInUnavailable')}</Badge>}
        </>
      }
      action={kind && kind !== 'override-in-menu' ? <VisitRowAction visit={visit} kind={kind} onAction={onAction} onWalkIn={onWalkIn} /> : undefined}
      moreActions={
        kind === 'override-in-menu'
          ? [{ id: 'check-in-anyway', label: t('actions.checkInAnyway'), icon: LogIn, mirrorIcon: true, onSelect: () => onAction({ kind: 'check-in', method: 'OVERRIDE', visit }) }]
          : []
      }
    />
  )
}
