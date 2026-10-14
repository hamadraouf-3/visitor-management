import { LogIn, LogOut } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Alert } from '../../components/ui/Alert'
import { useToast } from '../../components/ui/toastContext'
import type { Visit } from '../../types/api'
import { ConfirmVisitDialog } from './ConfirmVisitDialog'
import { CorrectCheckOutDialog } from './CorrectCheckOutDialog'
import { OverrideCheckInDialog } from './OverrideCheckInDialog'
import { useCheckIn, useCheckOut } from './queries'
import { isRecentCheckIn } from './scanOutcome'
import { checkedInAgo, overrideContext } from './visitActions'

/** An action on a visit chosen in a reception list (Expected, Inside, visitor search). */
export type ListVisitAction =
  | { kind: 'check-in'; method: 'MANUAL' | 'OVERRIDE'; visit: Visit }
  | { kind: 'check-out'; visit: Visit }
  | { kind: 'correct-check-out'; visit: Visit }

interface DialogProps<A extends ListVisitAction> {
  action: A
  timeZone: string
  now: number
  /** The action succeeded (called before the dialog closes). */
  onDone: (visit: Visit) => void
  onClose: () => void
}

/**
 * A check-in from a list. The visitor was found by name, not by a pass, so the dialog shows
 * the "Verify ID" cue before anything happens: MANUAL inside the pass window, OVERRIDE with a
 * reason outside it (§6).
 */
function ListCheckInDialog({ action, timeZone, now, onDone, onClose }: DialogProps<Extract<ListVisitAction, { kind: 'check-in' }>>) {
  const { t } = useTranslation('reception')
  const toast = useToast()
  const checkIn = useCheckIn()
  const { visit } = action
  const done = (updated: Visit) => {
    toast.show({ tone: 'success', title: t('checkedIn', { name: updated.visitor.full_name }) })
    onDone(updated)
    onClose()
  }

  if (action.method === 'OVERRIDE') {
    return (
      <OverrideCheckInDialog
        visit={visit}
        timeZone={timeZone}
        now={now}
        context={overrideContext(visit, now, timeZone)}
        pending={checkIn.isPending}
        error={checkIn.error}
        onConfirm={(reason) => checkIn.mutate({ visitId: visit.id, body: { method: 'OVERRIDE', reason } }, { onSuccess: done })}
        onClose={onClose}
      />
    )
  }
  return (
    <ConfirmVisitDialog
      visit={visit}
      timeZone={timeZone}
      now={now}
      title={t('checkInDialog.title')}
      verifyId
      confirmLabel={t('actions.checkIn')}
      confirmIcon={<LogIn aria-hidden="true" className="mirror-rtl" />}
      pending={checkIn.isPending}
      error={checkIn.error}
      onConfirm={() => checkIn.mutate({ visitId: visit.id, body: { method: 'MANUAL' } }, { onSuccess: done })}
      onClose={onClose}
    />
  )
}

/**
 * A check-out (MANUAL) that asks first: from "Find a visitor" (the visitor was found by name),
 * and from the Inside tab for a check-in less than 5 minutes ago, which is probably someone
 * arriving (§10's scanner rule; otherwise the Inside tab checks out in one tap).
 */
function ListCheckOutDialog({ action, timeZone, now, onDone, onClose }: DialogProps<Extract<ListVisitAction, { kind: 'check-out' }>>) {
  const { t } = useTranslation('reception')
  const toast = useToast()
  const checkOut = useCheckOut()
  const { visit } = action
  const recent = isRecentCheckIn(visit, now)
  return (
    <ConfirmVisitDialog
      visit={visit}
      timeZone={timeZone}
      now={now}
      title={t('checkOutDialog.title', { name: visit.visitor.full_name })}
      // One sentence for a check-out (the pass stops working); for a check-in minutes ago, the warning instead.
      description={recent ? t('checkOutDialog.recentNote') : t('checkOutDialog.description')}
      confirmLabel={t('actions.checkOut')}
      confirmIcon={<LogOut aria-hidden="true" className="mirror-rtl" />}
      initialFocus={recent ? 'cancel' : 'confirm'}
      pending={checkOut.isPending}
      error={checkOut.error}
      onConfirm={() =>
        checkOut.mutate(
          { visitId: visit.id, body: { method: 'MANUAL' } },
          {
            onSuccess: (updated) => {
              toast.show({ tone: 'success', title: t('checkedOut', { name: updated.visitor.full_name }) })
              onDone(updated)
              onClose()
            },
          },
        )
      }
      onClose={onClose}
    >
      {recent && (
        <Alert tone="warning" role="none" title={t('checkOutDialog.recentTitle', { ago: checkedInAgo(visit, now) })} />
      )}
    </ConfirmVisitDialog>
  )
}

export interface VisitActionDialogProps {
  action: ListVisitAction
  timeZone: string
  now: number
  /**
   * The check-in or check-out succeeded, called before the dialog closes: the list may drop
   * the row whose button opened the dialog, so the caller keeps focus in the list (see
   * useListFocusRecovery), and the scanner leaves a result about the same visit.
   */
  onDone: (visit: Visit) => void
  onClose: () => void
}

/** The dialog for an action chosen in a list; each dialog owns its request, so errors never carry over. */
export function VisitActionDialog({ action, timeZone, now, onDone, onClose }: VisitActionDialogProps) {
  switch (action.kind) {
    case 'check-in':
      return <ListCheckInDialog action={action} timeZone={timeZone} now={now} onDone={onDone} onClose={onClose} />
    case 'check-out':
      return <ListCheckOutDialog action={action} timeZone={timeZone} now={now} onDone={onDone} onClose={onClose} />
    case 'correct-check-out':
      return <CorrectCheckOutDialog visit={action.visit} timeZone={timeZone} onDone={onDone} onClose={onClose} />
  }
}
