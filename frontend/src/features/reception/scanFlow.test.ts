import { describe, expect, it } from 'vitest'
import {
  acceptsSubmission,
  actionAllowed,
  INITIAL_FLOW,
  scanFlowReducer,
  scannerPhase,
  type FlowEvent,
  type FlowState,
  type ScanSubmission,
} from './scanFlow'
import type { ScanOutcome } from './scanOutcome'
import { insideVisit, PASS_TOKEN, receptionVisit } from './testing/receptionFixtures'

/** When the scan's answer arrived. */
const SHOWN_AT = Date.parse('2026-10-06T06:10:00Z')
const camera = (id: number): ScanSubmission => ({ id, payload: PASS_TOKEN, source: 'camera' })
const keyboard = (id: number): ScanSubmission => ({ id, payload: PASS_TOKEN, source: 'keyboard' })
const READY: ScanOutcome = { kind: 'ready', visit: receptionVisit(), warnings: [], canCheckIn: true }
const INSIDE: ScanOutcome = { kind: 'inside', visit: insideVisit(), warnings: [], canCheckOut: true }
const EXPIRED: ScanOutcome = {
  kind: 'refused',
  code: 'PASS_EXPIRED',
  message: 'This visitor pass has expired.',
  visit: receptionVisit({ status: 'NO_SHOW' }),
  options: ['OVERRIDE'],
}

function run(events: FlowEvent[], from: FlowState = INITIAL_FLOW): FlowState {
  return events.reduce(scanFlowReducer, from)
}

describe('scannerPhase', () => {
  it('follows the camera while no pass is handled: idle → starting → scanning', () => {
    expect(scannerPhase(INITIAL_FLOW, 'idle')).toBe('idle')
    expect(scannerPhase(INITIAL_FLOW, 'error')).toBe('idle')
    expect(scannerPhase(INITIAL_FLOW, 'starting')).toBe('starting')
    expect(scannerPhase(INITIAL_FLOW, 'live')).toBe('scanning')
  })

  it('is the flow’s step while a pass is handled, whatever the camera does', () => {
    const validating = run([{ type: 'submitted', submission: camera(1) }])
    expect(scannerPhase(validating, 'live')).toBe('validating')
    expect(scannerPhase(validating, 'idle')).toBe('validating')
  })
})

describe('scanFlowReducer: the §10 cycle', () => {
  it('runs scanning → validating → result → acting → success → scanning', () => {
    const states: string[] = []
    let state = INITIAL_FLOW
    const step = (event: FlowEvent) => {
      state = scanFlowReducer(state, event)
      states.push(scannerPhase(state, 'live'))
    }
    states.push(scannerPhase(state, 'live'))
    step({ type: 'submitted', submission: camera(1) })
    step({ type: 'scanned', submissionId: 1, outcome: READY, at: SHOWN_AT })
    step({ type: 'action-started', action: { type: 'check-in', method: 'QR' } })
    step({ type: 'action-succeeded', visit: insideVisit() })
    step({ type: 'success-elapsed' })

    expect(states).toEqual(['scanning', 'validating', 'result', 'acting', 'success', 'scanning'])
  })

  it('records whether the visitor was checked in or out', () => {
    const checkedIn = run([
      { type: 'submitted', submission: camera(1) },
      { type: 'scanned', submissionId: 1, outcome: READY, at: SHOWN_AT },
      { type: 'action-started', action: { type: 'check-in', method: 'QR' } },
      { type: 'action-succeeded', visit: insideVisit() },
    ])
    expect(checkedIn).toMatchObject({ step: 'success', completed: 'checked-in' })

    const checkedOut = run([
      { type: 'submitted', submission: camera(2) },
      { type: 'scanned', submissionId: 2, outcome: INSIDE, at: SHOWN_AT },
      { type: 'action-started', action: { type: 'check-out', method: 'QR' } },
      { type: 'action-succeeded', visit: insideVisit({ status: 'CHECKED_OUT' }) },
    ])
    expect(checkedOut).toMatchObject({ step: 'success', completed: 'checked-out' })
  })

  it('returns to the result with the error when the action fails, and can act again', () => {
    const error = new Error('network')
    const failed = run([
      { type: 'submitted', submission: camera(1) },
      { type: 'scanned', submissionId: 1, outcome: READY, at: SHOWN_AT },
      { type: 'action-started', action: { type: 'check-in', method: 'QR' } },
      { type: 'action-failed', error },
    ])
    // The result keeps the time it arrived: its time-dependent actions are judged from then on.
    expect(failed).toMatchObject({ step: 'result', actionError: error, outcome: READY, shownAt: SHOWN_AT })
    expect(scanFlowReducer(failed, { type: 'action-started', action: { type: 'check-in', method: 'QR' } }).step).toBe('acting')
  })

  it('leaves a result without acting (Scan next)', () => {
    const shown = run([
      { type: 'submitted', submission: camera(1) },
      { type: 'scanned', submissionId: 1, outcome: READY, at: SHOWN_AT },
    ])
    expect(scanFlowReducer(shown, { type: 'dismissed' })).toBe(INITIAL_FLOW)
  })
})

describe('scanFlowReducer: one pass at a time (§10 de-duplication)', () => {
  it('takes no camera detection while a pass is checked, a result is shown, or an action runs', () => {
    const validating = run([{ type: 'submitted', submission: camera(1) }])
    expect(scanFlowReducer(validating, { type: 'submitted', submission: camera(2) })).toBe(validating)

    const result = run([{ type: 'scanned', submissionId: 1, outcome: READY, at: SHOWN_AT }], validating)
    expect(scanFlowReducer(result, { type: 'submitted', submission: camera(2) })).toBe(result)

    const acting = run([{ type: 'action-started', action: { type: 'check-in', method: 'QR' } }], result)
    expect(scanFlowReducer(acting, { type: 'submitted', submission: keyboard(3) })).toBe(acting)
  })

  it('lets a pass entered on purpose replace a shown result or the success state', () => {
    const result = run([
      { type: 'submitted', submission: camera(1) },
      { type: 'scanned', submissionId: 1, outcome: READY, at: SHOWN_AT },
    ])
    expect(scanFlowReducer(result, { type: 'submitted', submission: keyboard(2) })).toMatchObject({ step: 'validating', submission: { id: 2 } })
    expect(acceptsSubmission({ step: 'success', submission: camera(1), visit: insideVisit(), completed: 'checked-in' }, 'keyboard')).toBe(true)
    expect(acceptsSubmission({ step: 'success', submission: camera(1), visit: insideVisit(), completed: 'checked-in' }, 'camera')).toBe(false)
  })

  it('drops an answer for a submission that is no longer current', () => {
    const validating = run([{ type: 'submitted', submission: keyboard(2) }])
    expect(scanFlowReducer(validating, { type: 'scanned', submissionId: 1, outcome: READY, at: SHOWN_AT })).toBe(validating)
  })

  it('ignores events that do not fit the current step', () => {
    expect(scanFlowReducer(INITIAL_FLOW, { type: 'scanned', submissionId: 1, outcome: READY, at: SHOWN_AT })).toBe(INITIAL_FLOW)
    expect(scanFlowReducer(INITIAL_FLOW, { type: 'action-succeeded', visit: insideVisit() })).toBe(INITIAL_FLOW)
    expect(scanFlowReducer(INITIAL_FLOW, { type: 'success-elapsed' })).toBe(INITIAL_FLOW)
    const validating = run([{ type: 'submitted', submission: camera(1) }])
    expect(scanFlowReducer(validating, { type: 'dismissed' })).toBe(validating)
  })
})

describe('actionAllowed', () => {
  it('allows only the actions the outcome offers', () => {
    expect(actionAllowed(READY, { type: 'check-in', method: 'QR' })).toBe(true)
    expect(actionAllowed(READY, { type: 'check-out', method: 'QR' })).toBe(false)
    expect(actionAllowed({ ...READY, canCheckIn: false }, { type: 'check-in', method: 'QR' })).toBe(false)
    expect(actionAllowed(INSIDE, { type: 'check-out', method: 'QR' })).toBe(true)
    expect(actionAllowed(INSIDE, { type: 'check-in', method: 'QR' })).toBe(false)
    expect(actionAllowed(EXPIRED, { type: 'check-in', method: 'OVERRIDE', reason: 'Late train' })).toBe(true)
    expect(actionAllowed(EXPIRED, { type: 'check-in', method: 'OVERRIDE', reason: '   ' })).toBe(false)
    expect(actionAllowed(EXPIRED, { type: 'check-in', method: 'MANUAL' })).toBe(false)
    expect(actionAllowed({ ...EXPIRED, options: ['MANUAL'] }, { type: 'check-in', method: 'MANUAL' })).toBe(true)
    expect(actionAllowed({ kind: 'invalid', message: 'Invalid visitor pass.' }, { type: 'check-in', method: 'MANUAL' })).toBe(false)
  })

  it('keeps the reducer from starting an action the result does not offer', () => {
    const result = run([
      { type: 'submitted', submission: camera(1) },
      { type: 'scanned', submissionId: 1, outcome: READY, at: SHOWN_AT },
    ])
    expect(scanFlowReducer(result, { type: 'action-started', action: { type: 'check-out', method: 'QR' } })).toBe(result)
  })
})
