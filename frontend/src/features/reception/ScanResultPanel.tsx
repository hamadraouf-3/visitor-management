import {
  Building2,
  CalendarClock,
  Check,
  CircleAlert,
  CircleX,
  CloudOff,
  DoorOpen,
  IdCard,
  LogIn,
  LogOut,
  RotateCw,
  ScanQrCode,
  TicketX,
  TriangleAlert,
  UserPlus,
  type LucideIcon,
} from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { Alert } from '../../components/ui/Alert'
import { ApiErrorMessage } from '../../components/ui/ApiErrorMessage'
import { Button } from '../../components/ui/Button'
import { DataLine } from '../../components/ui/DataLine'
import { Spinner } from '../../components/ui/Spinner'
import { StatusBadge } from '../../components/ui/StatusBadge'
import { withParts } from '../../i18n/withParts'
import { useStableId } from '../../hooks/useStableId'
import type { Visit } from '../../types/api'
import { cn } from '../../utils/cn'
import { momentOnDay } from '../../utils/datetime'
import { formatTodayVisitTime } from '../visits/format'
import { initials } from '../../utils/text'
import { InsideFlagBadges } from '../visits/InsideFlagBadges'
import { ConfirmVisitDialog } from './ConfirmVisitDialog'
import { isModalOpen, mayMoveFocusInto } from './focusRules'
import { OverrideCheckInDialog } from './OverrideCheckInDialog'
import { scanAnnouncement } from './scanAnnouncement'
import type { FlowState, ScanAction } from './scanFlow'
import { refusalGuidance, scanNotices, scanResultActions, type ScanNotice } from './scanOutcome'
import { VisitFacts } from './VisitFacts'
import { checkedInAgo, nextArrivals } from './visitActions'
import { walkInPrefillFromVisit, type WalkInPrefill } from './walkInForm'

export interface ScanResultPanelProps {
  flow: FlowState
  /** The time the result is judged with (see useResultClock); the same one Enter acts on. */
  now: number
  timeZone: string
  /** Today's expected visits, for the next arrivals shown while nothing is scanned. */
  expected: readonly Visit[] | undefined
  /** The scanner (pass field and result): focus moves to a new result only from inside it, or from nowhere. */
  focusScope: RefObject<HTMLElement | null>
  onAct: (action: ScanAction) => void
  onDismiss: () => void
  onRetry: () => void
  onWalkIn: (prefill: WalkInPrefill) => void
  onShowExpected: () => void
  className?: string
}

/** Marks the control that takes focus when a result appears (§10: the primary action). */
const INITIAL_FOCUS = { 'data-initial-focus': '' }

/** How many of today's next arrivals the idle panel lists. */
const NEXT_ARRIVALS = 3

type VerdictTone = 'success' | 'info' | 'warning' | 'danger'

/*
 * The verdict band across the top of the result (direction C's lime band, in mawdoo3's colours).
 * Every pair is a token pair with its ratio noted in index.css; on the dark reception screen:
 * success turquoise with ink text (7.31:1), info the info tint with its text (8.73:1), warning
 * mawdoo3's yellow with ink text (8.74:1), danger the solid red with white text (4.67:1). The disc
 * behind the icon inverts the band.
 */
const VERDICT_TONES: Record<VerdictTone, { band: string; disc: string; icon: LucideIcon }> = {
  success: { band: 'bg-accent text-on-accent', disc: 'bg-on-accent text-accent', icon: Check },
  info: { band: 'bg-info-surface text-info-text', disc: 'bg-info-solid text-info-surface', icon: DoorOpen },
  warning: { band: 'bg-attention text-on-attention', disc: 'bg-on-attention text-attention', icon: TriangleAlert },
  danger: { band: 'bg-danger-solid text-on-danger', disc: 'bg-on-danger text-danger-solid', icon: CircleX },
}

/**
 * What the scan found, first and large, seen from the desk at a glance: an icon disc and the
 * verdict, with a line under it only for a failed check (the error). `data-tone` names the tone,
 * as an `Alert` does.
 */
function Verdict({ tone, icon, title, children }: { tone: VerdictTone; icon?: LucideIcon; title: ReactNode; children?: ReactNode }) {
  const { band, disc, icon: toneIcon } = VERDICT_TONES[tone]
  const Icon = icon ?? toneIcon
  return (
    <div data-tone={tone} className={cn('flex items-center gap-4 px-5 py-4 sm:px-6', band)}>
      <span aria-hidden="true" className={cn('flex size-12 shrink-0 items-center justify-center rounded-full sm:size-14', disc)}>
        <Icon className="size-6 sm:size-7" strokeWidth={2.75} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-xl leading-snug font-bold break-words sm:text-2xl">{title}</p>
        {children && <div className="mt-0.5 text-sm leading-relaxed font-medium break-words">{children}</div>}
      </div>
    </div>
  )
}

/**
 * The visitor, large (direction C): an initials tile, the name and the visitor's company, with
 * the visit's status badge (and flags) above the name where they say something the verdict does
 * not; a valid pass leaves the badge out, because "Scheduled" is the visit's status, not the
 * scan's. Then the "Verify ID" cue where reception checks the visitor in, framed in turquoise.
 */
function VisitorHeading({ visit, verifyId, flags, showStatus = true }: { visit: Visit; verifyId: boolean; flags?: ReactNode; showStatus?: boolean }) {
  const { t } = useTranslation('reception')
  const name = visit.visitor.full_name
  return (
    <div className="flex flex-col gap-4">
      <div className="flex min-w-0 items-start gap-4">
        <span
          aria-hidden="true"
          className="flex size-14 shrink-0 items-center justify-center rounded-card border border-border bg-emphasis text-lg font-semibold text-highlight select-none sm:size-16 sm:text-xl"
        >
          {initials(name)}
        </span>
        <div className="min-w-0 flex-1">
          {showStatus && (
            <p className="mb-2 flex flex-wrap items-center gap-2">
              <StatusBadge type="visit" status={visit.status} />
              {flags}
            </p>
          )}
          <h3 className="text-[1.75rem] leading-tight font-bold tracking-tight break-words text-fg sm:text-[2rem]">{name}</h3>
          {visit.visitor.company_name && (
            <p className="mt-1 flex items-center gap-1.5 text-base break-words text-fg-secondary">
              <Building2 aria-hidden="true" className="size-4 shrink-0 text-fg-muted" />
              {visit.visitor.company_name}
            </p>
          )}
        </div>
      </div>
      {verifyId && (
        <p className="flex min-h-14 items-center gap-3 rounded-card border-[1.5px] border-accent-strong bg-accent-surface px-4 py-3 text-base font-semibold break-words text-fg">
          <IdCard aria-hidden="true" className="size-6 shrink-0 text-accent-text" />
          {t('verifyId', { name })}
        </p>
      )}
    </div>
  )
}

/**
 * The actions of every result in one layout, at the foot of the panel: "Scan next" (and "Check
 * pass again") first, then the outcome's own actions with the primary last. The `end` group is
 * where a check-in sits: it takes the rest of the row from `sm` (direction C's wide primary),
 * full width at the bottom on phones. The `start` group is a row at the start (on phones the top
 * row, its buttons sharing the width). A check-out never takes the `end` group: it sits in
 * `start` beside "Scan next", so the place reception taps for "the usual button" never checks out
 * the visitor who is inside (§10 "styled/positioned differently"). The visual order is the DOM
 * (and Tab) order.
 */
function ActionRow({ start, end }: { start: ReactNode; end?: ReactNode }) {
  return (
    <div className="mt-auto flex flex-col gap-3 pt-1 sm:flex-row sm:flex-wrap sm:items-center">
      <div data-action-group="start" className="flex flex-wrap items-center gap-3 max-sm:[&>*]:grow">
        {start}
      </div>
      {end && (
        <div data-action-group="end" className="flex flex-col gap-3 sm:flex-1 sm:flex-row sm:flex-wrap sm:justify-end sm:[&>*]:grow">
          {end}
        </div>
      )}
    </div>
  )
}

/** A result's warnings, worded from the visit's times (see scanNotices). */
function Notices({ notices }: { notices: readonly ScanNotice[] }) {
  return notices.map((notice) => (
    <Alert key={notice.key} tone={notice.tone} role="none" className="py-3">
      {notice.text}
    </Alert>
  ))
}

/**
 * A result about no visit (an invalid pass, no verdict): the verdict's symbol, large and quiet,
 * where a visit's facts would be, so the panel stays balanced without a sentence (decision 3).
 */
function NoVisitFigure({ icon: Icon, tone }: { icon: LucideIcon; tone: 'danger' | 'neutral' }) {
  return (
    <div aria-hidden="true" className="flex flex-1 items-center justify-center py-6">
      <span
        className={cn(
          'flex size-24 items-center justify-center rounded-full ring-1',
          tone === 'danger' ? 'bg-danger-surface text-danger-text ring-danger-border' : 'bg-surface-muted text-fg-muted ring-border',
        )}
      >
        <Icon className="size-11" strokeWidth={1.75} />
      </span>
    </div>
  )
}

/** The verdict across the top, the rest under it with the actions at the panel's foot. */
function ResultLayout({ verdict, children }: { verdict: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col">
      {verdict}
      <div className="flex flex-1 flex-col gap-5 p-5 sm:p-6">{children}</div>
    </div>
  )
}

type ResultStep = Extract<FlowState, { step: 'result' | 'acting' }>

interface ResultContentProps {
  flow: ResultStep
  timeZone: string
  now: number
  onAct: (action: ScanAction) => void
  onDismiss: () => void
  onRetry: () => void
  onWalkIn: (prefill: WalkInPrefill) => void
}

/**
 * One scan result. READY opens with its verdict ("Valid pass – ready to check in"), offers one
 * primary action, Check in, and says whether the visitor is early or late. ALREADY_CHECKED_IN
 * opens with what happened ("Already checked in at 13:03", a pass presented twice may be a
 * forwarded one, §12), flags an overdue or previous-day visitor as the lists do, and offers Check
 * out outlined and beside "Scan next", never in Check in's place; only as a secondary action with
 * a confirmation if the check-in was less than 5 minutes ago (§10). Refused passes show what
 * happened with its facts, and the check-ins the server still allows (`check_in_options`) or a
 * walk-in.
 */
function ResultContent({ flow, timeZone, now, onAct, onDismiss, onRetry, onWalkIn }: ResultContentProps) {
  const { t } = useTranslation('reception')
  const [dialog, setDialog] = useState<'override' | 'check-out' | null>(null)
  const { outcome } = flow
  const acting = flow.step === 'acting' ? flow.action : null
  const actionError = flow.step === 'result' ? flow.actionError : null
  const busy = acting !== null
  const actions = scanResultActions(outcome, now)
  const loadingFor = (match: (action: ScanAction) => boolean) => acting !== null && match(acting)

  const scanNext = (initialFocus: boolean) => (
    <Button
      variant="secondary"
      size="lg"
      icon={<ScanQrCode aria-hidden="true" />}
      onClick={onDismiss}
      disabled={busy}
      focusableWhenDisabled
      {...(initialFocus ? INITIAL_FOCUS : {})}
    >
      {t('scan.next.button')}
    </Button>
  )
  const checkAgain = Boolean(actionError) && (
    <Button variant="secondary" size="lg" icon={<RotateCw aria-hidden="true" />} onClick={onRetry} disabled={busy} focusableWhenDisabled>
      {t('scan.checkPassAgain')}
    </Button>
  )
  const actionErrorAlert = Boolean(actionError) && (
    <Alert tone="danger" role="none">
      <ApiErrorMessage error={actionError} />
    </Alert>
  )

  if (outcome.kind === 'ready') {
    const { visit } = outcome
    return (
      <ResultLayout verdict={<Verdict tone="success" title={outcome.canCheckIn ? t('scan.validReady') : t('scan.valid')} />}>
        <VisitorHeading visit={visit} verifyId showStatus={false} />
        {actionErrorAlert}
        <Notices notices={scanNotices(outcome, now, timeZone)} />
        <VisitFacts visit={visit} timeZone={timeZone} now={now} showCompany={false} />
        <ActionRow
          start={
            <>
              {scanNext(actions.primary === null)}
              {checkAgain}
            </>
          }
          end={
            actions.primary === 'check-in' && (
              <Button
                size="xl"
                icon={<LogIn aria-hidden="true" className="mirror-rtl" />}
                loading={loadingFor((action) => action.type === 'check-in')}
                onClick={() => onAct({ type: 'check-in', method: 'QR' })}
                {...INITIAL_FOCUS}
              >
                {t('actions.checkIn')}
              </Button>
            )
          }
        />
      </ResultLayout>
    )
  }

  if (outcome.kind === 'inside') {
    const { visit } = outcome
    const checkOutLoading = loadingFor((action) => action.type === 'check-out')
    // «الساعة» only before a time: a check-in on an earlier day is said with its date (alreadyInOn).
    const checkedIn = visit.check_in_at ? momentOnDay(visit.check_in_at, now, timeZone) : null
    return (
      <ResultLayout
        verdict={
          <Verdict
            tone="info"
            title={
              checkedIn
                ? t(checkedIn.sameDay ? 'scan.alreadyInAt' : 'scan.alreadyInOn', { date: checkedIn.date, time: checkedIn.time, ago: checkedInAgo(visit, now) })
                : t('scan.alreadyIn')
            }
          />
        }
      >
        <VisitorHeading visit={visit} verifyId={false} flags={<InsideFlagBadges visit={visit} timeZone={timeZone} now={now} />} />
        {actionErrorAlert}
        <Notices notices={scanNotices(outcome, now, timeZone)} />
        <VisitFacts visit={visit} timeZone={timeZone} now={now} showCompany={false} />
        <ActionRow
          start={
            <>
              {scanNext(actions.primary === null)}
              {checkAgain}
              {actions.primary === 'check-out' ? (
                // Outlined and beside "Scan next", never in Check in's place (see ActionRow); still
                // the action that takes focus, so Enter checks out (§10).
                <Button
                  variant="secondary"
                  size="lg"
                  icon={<LogOut aria-hidden="true" className="mirror-rtl" />}
                  loading={checkOutLoading}
                  onClick={() => onAct({ type: 'check-out', method: 'QR' })}
                  {...INITIAL_FOCUS}
                >
                  {t('actions.checkOut')}
                </Button>
              ) : (
                actions.confirmCheckOut && (
                  <Button
                    variant="secondary"
                    size="lg"
                    icon={<LogOut aria-hidden="true" className="mirror-rtl" />}
                    loading={checkOutLoading}
                    onClick={() => setDialog('check-out')}
                  >
                    {t('actions.checkOutConfirm')}
                  </Button>
                )
              )}
            </>
          }
        />
        {dialog === 'check-out' && (
          <ConfirmVisitDialog
            visit={visit}
            timeZone={timeZone}
            now={now}
            title={t('checkOutDialog.title', { name: visit.visitor.full_name })}
            description={t('checkOutDialog.recentNote')}
            confirmLabel={t('actions.checkOut')}
            confirmIcon={<LogOut aria-hidden="true" className="mirror-rtl" />}
            initialFocus="cancel"
            pending={checkOutLoading}
            error={actionError}
            onConfirm={() => onAct({ type: 'check-out', method: 'QR' })}
            onClose={() => setDialog(null)}
          >
            <Alert tone="warning" role="none" title={t('checkOutDialog.recentTitle', { ago: checkedInAgo(visit, now) })} />
          </ConfirmVisitDialog>
        )}
      </ResultLayout>
    )
  }

  if (outcome.kind === 'failed') {
    return (
      <ResultLayout
        verdict={
          <Verdict tone="danger" icon={CircleAlert} title={t('scan.failed')}>
            <ApiErrorMessage error={outcome.error} />
          </Verdict>
        }
      >
        <NoVisitFigure icon={CloudOff} tone="neutral" />
        <ActionRow
          start={scanNext(false)}
          end={
            <Button size="lg" icon={<RotateCw aria-hidden="true" />} onClick={onRetry} {...INITIAL_FOCUS}>
              {t('scan.checkAgain')}
            </Button>
          }
        />
      </ResultLayout>
    )
  }

  const guidance = refusalGuidance(outcome, now, timeZone)
  const visit = outcome.kind === 'refused' ? outcome.visit : null
  const initialFocus = actions.manualCheckIn ? 'manual' : actions.overrideCheckIn ? 'override' : 'scan-next'
  const walkIn = guidance.walkIn
  const outcomeActions = (actions.manualCheckIn || actions.overrideCheckIn || walkIn) && (
    <>
      {walkIn && (
        <Button
          variant="secondary"
          size="lg"
          icon={<UserPlus aria-hidden="true" />}
          onClick={() => onWalkIn(walkInPrefillFromVisit(walkIn.visit, walkIn))}
        >
          {t('actions.registerWalkIn')}
        </Button>
      )}
      {actions.overrideCheckIn && (
        <Button
          variant={actions.manualCheckIn ? 'secondary' : 'primary'}
          size="lg"
          icon={<LogIn aria-hidden="true" className="mirror-rtl" />}
          disabled={busy}
          focusableWhenDisabled
          onClick={() => setDialog('override')}
          {...(initialFocus === 'override' ? INITIAL_FOCUS : {})}
        >
          {t('actions.checkInAnyway')}
        </Button>
      )}
      {actions.manualCheckIn && (
        <Button
          size="lg"
          icon={<IdCard aria-hidden="true" />}
          loading={loadingFor((action) => action.type === 'check-in' && action.method === 'MANUAL')}
          disabled={busy}
          focusableWhenDisabled
          onClick={() => onAct({ type: 'check-in', method: 'MANUAL' })}
          {...(initialFocus === 'manual' ? INITIAL_FOCUS : {})}
        >
          {t('actions.verifyAndCheckIn')}
        </Button>
      )}
    </>
  )
  return (
    <ResultLayout
      verdict={
        // The title alone, with its facts (when, who): the server's message restated it under it
        // («أُلغيت الزيارة بواسطة …» over «أُلغيت هذه الزيارة.») or added advice the panel's actions
        // already give (decision 3). An invalid pass's message is its title.
        <Verdict tone={guidance.tone} title={guidance.title ?? outcome.message} />
      }
    >
      {actionErrorAlert}
      {!visit && <NoVisitFigure icon={TicketX} tone="danger" />}
      {visit && (
        <>
          <VisitorHeading visit={visit} verifyId={actions.manualCheckIn || actions.overrideCheckIn} />
          <VisitFacts
            visit={visit}
            timeZone={timeZone}
            now={now}
            showCompany={false}
            showWindow={visit.status === 'SCHEDULED' || visit.status === 'NO_SHOW'}
          />
        </>
      )}
      <ActionRow
        start={
          <>
            {scanNext(initialFocus === 'scan-next')}
            {checkAgain}
          </>
        }
        end={outcomeActions}
      />
      {dialog === 'override' && visit && outcome.kind === 'refused' && (
        <OverrideCheckInDialog
          visit={visit}
          timeZone={timeZone}
          now={now}
          context={outcome.message}
          pending={loadingFor((action) => action.type === 'check-in' && action.method === 'OVERRIDE')}
          error={actionError}
          onConfirm={(reason) => onAct({ type: 'check-in', method: 'OVERRIDE', reason })}
          onClose={() => setDialog(null)}
        />
      )}
    </ResultLayout>
  )
}

interface ReadyContentProps {
  expected: readonly Visit[] | undefined
  now: number
  timeZone: string
  onShowExpected: () => void
}

/** While nothing is scanned: the scanner's state, large, and who is expected next today. */
function ReadyContent({ expected, now, timeZone, onShowExpected }: ReadyContentProps) {
  const { t } = useTranslation('reception')
  const next = expected ? nextArrivals(expected, now, NEXT_ARRIVALS) : []
  return (
    <div className="flex flex-1 flex-col">
      <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 py-10 text-center">
        <span aria-hidden="true" className="flex size-20 items-center justify-center rounded-full bg-accent-surface text-accent-text ring-1 ring-accent-border">
          <ScanQrCode className="size-10" />
        </span>
        <p className="text-xl font-semibold text-fg">{t('scan.readyTitle')}</p>
      </div>
      {next.length > 0 && (
        <section aria-labelledby="next-arrivals-heading" className="border-t border-border">
          <div className="flex items-center justify-between gap-3 ps-5 pe-3 pt-3 sm:ps-6">
            <h3 id="next-arrivals-heading" className="flex items-center gap-2 text-sm font-semibold text-fg-secondary">
              <CalendarClock aria-hidden="true" className="size-4 shrink-0 text-fg-muted" />
              {t('scan.expectedNext')}
            </h3>
            <Button variant="ghost" onClick={onShowExpected}>
              {t('scan.allExpected')}
            </Button>
          </div>
          <ul className="divide-y divide-border-subtle pb-2">
            {next.map((visit) => (
              <li key={visit.id} className="flex min-w-0 items-center gap-4 px-5 py-3 sm:px-6">
                <span className="w-24 shrink-0 font-numeric text-sm font-medium text-fg tabular-nums">
                  {formatTodayVisitTime(visit.scheduled_start, visit.scheduled_end, timeZone, now)}
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="text-[0.90625rem] leading-snug font-semibold break-words text-fg">{visit.visitor.full_name}</span>
                  <span className="text-meta break-words text-fg-muted">
                    <DataLine
                      items={[
                        visit.visitor.company_name,
                        withParts((markers) => t('hostNamed', { name: markers.name }), { name: <bdi>{visit.host.full_name}</bdi> }),
                      ]}
                    />
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

/**
 * The scan result panel (§10), direction C: a dark panel the height of the camera column. Its
 * live region announces each state in one sentence; when a result appears, focus moves to its
 * primary action (or the first action it offers); Escape leaves the result. After a successful
 * action the panel shows a large turquoise check for about 1.5 s while scanning resumes.
 */
export function ScanResultPanel({
  flow,
  now,
  timeZone,
  expected,
  focusScope,
  onAct,
  onDismiss,
  onRetry,
  onWalkIn,
  onShowExpected,
  className,
}: ScanResultPanelProps) {
  const { t } = useTranslation('reception')
  const containerRef = useRef<HTMLElement>(null)
  const headingId = useStableId('scan-result')
  const resultId = flow.step === 'result' ? flow.submission.id : null

  useEffect(() => {
    if (resultId === null || !mayMoveFocusInto(focusScope.current)) return
    containerRef.current?.querySelector<HTMLElement>('[data-initial-focus]')?.focus()
  }, [resultId, focusScope])

  const showingResult = flow.step === 'result'
  useEffect(() => {
    if (!showingResult) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || isModalOpen() || !mayMoveFocusInto(focusScope.current)) return
      event.preventDefault()
      onDismiss()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [showingResult, onDismiss, focusScope])

  let content: ReactNode
  switch (flow.step) {
    case 'ready':
      content = <ReadyContent expected={expected} now={now} timeZone={timeZone} onShowExpected={onShowExpected} />
      break
    case 'validating':
      content = (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 py-10">
          <Spinner size="lg" decorative className="text-accent-text" />
          <span className="text-lg font-medium text-fg">{t('scan.checking')}</span>
        </div>
      )
      break
    case 'success':
      content = (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-10 text-center">
          <span className="mb-1 flex size-24 items-center justify-center rounded-full bg-accent text-on-accent shadow-[0_0_0_10px_var(--color-accent-surface)]">
            <Check aria-hidden="true" className="size-12" strokeWidth={3} />
          </span>
          <p className="text-[1.75rem] leading-tight font-bold text-fg">{flow.completed === 'checked-in' ? t('scan.successIn') : t('scan.successOut')}</p>
          <p className="text-xl font-medium break-words text-fg-secondary">{flow.visit.visitor.full_name}</p>
        </div>
      )
      break
    case 'result':
    case 'acting':
      content = (
        <ResultContent
          key={flow.submission.id}
          flow={flow}
          timeZone={timeZone}
          now={now}
          onAct={onAct}
          onDismiss={onDismiss}
          onRetry={onRetry}
          onWalkIn={onWalkIn}
        />
      )
      break
  }

  return (
    <section
      ref={containerRef}
      aria-labelledby={headingId}
      className={cn(
        'flex flex-col overflow-hidden rounded-panel border bg-surface',
        flow.step === 'ready' ? 'min-h-48' : 'min-h-64',
        flow.step === 'success' ? 'border-accent-strong' : 'border-border',
        className,
      )}
    >
      <h2 id={headingId} className="sr-only">
        {t('scan.resultHeading')}
      </h2>
      <p role="status" className="sr-only">
        {scanAnnouncement(flow, now, timeZone)}
      </p>
      {content}
    </section>
  )
}
