import type { CameraStatus } from '../../scanner/useCameraStream'
import type { Visit } from '../../types/api'
import type { ScanOutcome } from './scanOutcome'

/**
 * The reception scanner as a state machine (§10):
 *
 *   idle → starting → scanning → validating → result → acting → success (≈1.5 s) → scanning
 *
 * Two parts move independently: the camera (`idle`, `starting`, live = `scanning`) and the
 * flow of one pass (`validating` → `result` → `acting` → `success`). This module holds the
 * flow as a pure reducer; `scannerPhase` combines it with the camera into the state above.
 * A pass typed or pasted into the handheld field runs the same flow without a camera.
 */

/** §10: the success state is shown for about 1.5 s, then scanning resumes on its own. */
export const SUCCESS_DISPLAY_MS = 1_500

export type ScanSource = 'camera' | 'keyboard'

export interface ScanSubmission {
  id: number
  /** What is sent as `token` to /reception/scan, and as `pass_token` for the QR check-in/out. */
  payload: string
  source: ScanSource
}

/** An action taken on a scan result. QR actions re-present the scanned pass; the others need an ID check. */
export type ScanAction =
  | { type: 'check-in'; method: 'QR' }
  | { type: 'check-in'; method: 'MANUAL' }
  | { type: 'check-in'; method: 'OVERRIDE'; reason: string }
  | { type: 'check-out'; method: 'QR' }

/**
 * `shownAt` is when the result arrived: time-dependent rules (a check-in less than 5 minutes
 * ago needs a confirmation) are judged from then on, never with an older reading of the clock.
 */
export type FlowState =
  | { step: 'ready' }
  | { step: 'validating'; submission: ScanSubmission }
  | { step: 'result'; submission: ScanSubmission; outcome: ScanOutcome; actionError: unknown; shownAt: number }
  | { step: 'acting'; submission: ScanSubmission; outcome: ScanOutcome; action: ScanAction; shownAt: number }
  | { step: 'success'; submission: ScanSubmission; visit: Visit; completed: 'checked-in' | 'checked-out' }

export type FlowEvent =
  | { type: 'submitted'; submission: ScanSubmission }
  | { type: 'scanned'; submissionId: number; outcome: ScanOutcome; at: number }
  | { type: 'action-started'; action: ScanAction }
  | { type: 'action-succeeded'; visit: Visit }
  | { type: 'action-failed'; error: unknown }
  | { type: 'dismissed' }
  | { type: 'success-elapsed' }

export const INITIAL_FLOW: FlowState = { step: 'ready' }

export type ScannerPhase = 'idle' | 'starting' | 'scanning' | 'validating' | 'result' | 'acting' | 'success'

/** The §10 state: the flow's step while a pass is handled, otherwise the camera's. */
export function scannerPhase(flow: FlowState, camera: CameraStatus): ScannerPhase {
  if (flow.step !== 'ready') return flow.step
  if (camera === 'live') return 'scanning'
  if (camera === 'starting') return 'starting'
  return 'idle'
}

/**
 * Whether a new pass is taken now. One pass at a time: nothing while a scan or an action is
 * running. The camera's decoding is paused while a result or the success state is shown
 * (§10 de-duplication); a pass entered on purpose (handheld scanner, paste) replaces them.
 */
export function acceptsSubmission(flow: FlowState, source: ScanSource): boolean {
  switch (flow.step) {
    case 'ready':
      return true
    case 'result':
    case 'success':
      return source === 'keyboard'
    case 'validating':
    case 'acting':
      return false
  }
}

/** Whether `action` is one the outcome offers (the panel only shows those; this guards the reducer). */
export function actionAllowed(outcome: ScanOutcome, action: ScanAction): boolean {
  if (action.type === 'check-out') return outcome.kind === 'inside' && outcome.canCheckOut
  switch (action.method) {
    case 'QR':
      return outcome.kind === 'ready' && outcome.canCheckIn
    case 'MANUAL':
      return outcome.kind === 'refused' && outcome.visit !== null && outcome.options.includes('MANUAL')
    case 'OVERRIDE':
      return outcome.kind === 'refused' && outcome.visit !== null && outcome.options.includes('OVERRIDE') && action.reason.trim() !== ''
  }
}

/** The visit a scan result is about, if the server named one. */
export function outcomeVisit(outcome: ScanOutcome): Visit | null {
  switch (outcome.kind) {
    case 'ready':
    case 'inside':
    case 'refused':
      return outcome.visit
    case 'invalid':
    case 'failed':
      return null
  }
}

export function scanFlowReducer(state: FlowState, event: FlowEvent): FlowState {
  switch (event.type) {
    case 'submitted':
      return acceptsSubmission(state, event.submission.source) ? { step: 'validating', submission: event.submission } : state
    case 'scanned':
      // An answer for a submission that is no longer current is dropped.
      if (state.step !== 'validating' || state.submission.id !== event.submissionId) return state
      return { step: 'result', submission: state.submission, outcome: event.outcome, actionError: null, shownAt: event.at }
    case 'action-started':
      if (state.step !== 'result' || !actionAllowed(state.outcome, event.action)) return state
      return { step: 'acting', submission: state.submission, outcome: state.outcome, action: event.action, shownAt: state.shownAt }
    case 'action-succeeded':
      if (state.step !== 'acting') return state
      return {
        step: 'success',
        submission: state.submission,
        visit: event.visit,
        completed: state.action.type === 'check-in' ? 'checked-in' : 'checked-out',
      }
    case 'action-failed':
      if (state.step !== 'acting') return state
      return { step: 'result', submission: state.submission, outcome: state.outcome, actionError: event.error, shownAt: state.shownAt }
    case 'dismissed':
      return state.step === 'result' || state.step === 'success' ? INITIAL_FLOW : state
    case 'success-elapsed':
      return state.step === 'success' ? INITIAL_FLOW : state
  }
}
