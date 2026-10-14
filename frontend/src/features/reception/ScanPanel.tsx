import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Checkbox } from '../../components/ui/Checkbox'
import { useMediaQuery } from '../../hooks/useMediaQuery'
import type { Visit } from '../../types/api'
import { isFocusLost } from '../../utils/focus'
import { CameraView } from './CameraView'
import { mayMoveFocusInto } from './focusRules'
import { PassInput } from './PassInput'
import { scanResultActions, type PrimaryAction } from './scanOutcome'
import { ScanResultPanel } from './ScanResultPanel'
import { useResultClock } from './useResultClock'
import type { ScanStation } from './useScanStation'
import { useScannerKeyboard } from './useScannerKeyboard'
import type { WalkInPrefill } from './walkInForm'

export interface ScanPanelProps {
  station: ScanStation
  timeZone: string
  /** Today's expected visits (the next arrivals are shown while nothing is scanned); undefined while loading. */
  expected: readonly Visit[] | undefined
  onWalkIn: (prefill: WalkInPrefill) => void
  onShowExpected: () => void
  /**
   * The tab opens because the screen moved here with focus lost (a walk-in was registered and
   * its tab closed): the pass entry takes focus. Otherwise a touch screen's pass entry waits
   * for a scan, an action or "Scan next" before it takes focus from the page.
   */
  focusPassEntryOnOpen?: boolean
}

/** Touch screens get the collapsed pass field (§10). */
export const COARSE_POINTER_QUERY = '(pointer: coarse)'

/**
 * The Scan tab (§10), direction C's reception tablet: the camera and the pass entry bar right
 * under it, then the result panel. Side by side from `lg` (the result panel as tall as the
 * camera column, 28 rem wide from `xl`); on tablets in portrait and on phones stacked, the camera
 * across the whole width, shrinking to a strip while a result is shown so the result and its
 * action fit the screen. The beep switch, a set-once device preference, comes last: under the
 * pass entry from `lg`, below the result when stacked, so it never stands between the camera and
 * the way to scan without it. When the camera fails, the pass entry is the way to scan and looks it.
 *
 * Focus: after an action, after leaving a result and when the tab opens with focus nowhere
 * because a walk-in was just registered, it moves to the pass entry: the field on
 * fine-pointer devices, the "Enter or paste pass" button on touch screens, so no on-screen
 * keyboard opens. On touch screens a page that has just loaded (a kiosk reload, a bookmark)
 * keeps focus where it is until a scan, an action or "Scan next" happens, as an arrival by
 * navigation keeps it on the heading.
 */
export function ScanPanel({ station, timeZone, expected, onWalkIn, onShowExpected, focusPassEntryOnOpen = false }: ScanPanelProps) {
  const { t } = useTranslation('reception')
  const coarse = useMediaQuery(COARSE_POINTER_QUERY)
  const [expanded, setExpanded] = useState(false)
  const scopeRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const toggleRef = useRef<HTMLButtonElement>(null)
  // Whether a pass was handled since the tab opened (the touch-screen focus rule above).
  const handledRef = useRef(false)
  const { flow, actPrimary } = station
  const cameraFailed = station.camera.status === 'error'

  // One clock for what the panel shows and what Enter does (the 5-minute check-out rule).
  const now = useResultClock(flow)
  const primary = flow.step === 'result' ? scanResultActions(flow.outcome, now).primary : null
  const primaryRef = useRef<PrimaryAction | null>(primary)
  useEffect(() => {
    primaryRef.current = primary
  })
  const enterPrimary = useCallback(() => actPrimary(primaryRef.current), [actPrimary])

  useScannerKeyboard({ enabled: true, coarse, expanded, setExpanded, inputRef, onEnter: enterPrimary })

  const step = flow.step
  useEffect(() => {
    if (step !== 'ready') handledRef.current = true
    if ((step !== 'success' && step !== 'ready') || !mayMoveFocusInto(scopeRef.current)) return
    if (!coarse || expanded) {
      inputRef.current?.focus()
      return
    }
    // Touch screens: after an action, or when the focused control is gone (a result left, the
    // Walk-in tab closed by its walk-in); never from the landing heading, nor from the page of
    // a fresh load (a tap opens the field when it is wanted).
    if (step === 'success' || (isFocusLost() && (handledRef.current || focusPassEntryOnOpen))) toggleRef.current?.focus()
  }, [step, coarse, expanded, focusPassEntryOnOpen])

  return (
    <div
      ref={scopeRef}
      className="grid grid-cols-1 gap-4 lg:grid-cols-2 lg:grid-rows-[auto_1fr] lg:gap-x-5 xl:grid-cols-[minmax(0,1fr)_28rem]"
    >
      <div className="flex min-w-0 flex-col gap-3 lg:col-start-1 lg:row-start-1">
        <CameraView camera={station.camera} phase={station.phase} setVideo={station.setVideo} />
        <PassInput
          coarse={coarse}
          expanded={expanded}
          onExpandedChange={setExpanded}
          busy={flow.step === 'validating'}
          onSubmitPass={station.submitInput}
          onEmptyEnter={enterPrimary}
          inputRef={inputRef}
          toggleRef={toggleRef}
          emphasised={cameraFailed}
        />
      </div>
      <ScanResultPanel
        flow={flow}
        now={now}
        timeZone={timeZone}
        expected={expected}
        focusScope={scopeRef}
        onAct={station.act}
        onDismiss={station.dismiss}
        onRetry={station.retry}
        onWalkIn={onWalkIn}
        onShowExpected={onShowExpected}
        className="lg:col-start-2 lg:row-span-2 lg:row-start-1"
      />
      <Checkbox
        label={t('scan.beep')}
        checked={station.successFeedback}
        onChange={(event) => station.setSuccessFeedback(event.target.checked)}
        className="px-1 lg:col-start-1 lg:row-start-2 lg:self-start"
      />
    </div>
  )
}
