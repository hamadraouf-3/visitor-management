import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import type { CheckInRequest, Visit } from '../../types/api'
import { CAMERA_ERRORS } from '../../scanner/cameraErrors'
import { playSuccessFeedback, primeSuccessFeedback } from '../../scanner/feedback'
import { parsePassToken } from '../../scanner/parsePassToken'
import { readSuccessFeedback, storeSuccessFeedback } from '../../scanner/preferences'
import { createRepeatGate, detectionKey } from '../../scanner/repeatGate'
import { useCameraStream, type CameraControls } from '../../scanner/useCameraStream'
import type { DecoderPreloadState } from '../../scanner/useQrDecoderPreload'
import { useQrDecodeLoop } from '../../scanner/useQrDecodeLoop'
import { useCheckIn, useCheckOut, useScanPass } from './queries'
import {
  acceptsSubmission,
  actionAllowed,
  INITIAL_FLOW,
  outcomeVisit,
  scanFlowReducer,
  scannerPhase,
  SUCCESS_DISPLAY_MS,
  type FlowEvent,
  type FlowState,
  type ScanAction,
  type ScannerPhase,
  type ScanSource,
  type ScanSubmission,
} from './scanFlow'
import { outcomeFromScanError, outcomeFromScanResult, type PrimaryAction } from './scanOutcome'

/** `ScanRequest.token` accepts at most 4,096 characters (B1-49); longer input is still an invalid pass. */
export const SCAN_INPUT_MAX_LENGTH = 4_096

/**
 * Sent in place of a QR code the camera read that is not a pass. It is not a well-formed
 * token, so the server answers PASS_INVALID and audits the attempt (§6 row 1) as for any
 * other malformed input.
 */
export const UNRECOGNISED_QR_PLACEHOLDER = 'unrecognised-qr'

/**
 * What is sent for scanner input. A recognised pass is sent as its bare token (the same pass
 * as a URL or a token is one request body); the client never decides on its own that a pass
 * is invalid, so anything else is sent too and the server answers PASS_INVALID and audits it.
 * - Typed, pasted or from a handheld scanner (a deliberate entry): sent as entered (trimmed,
 *   at most 4,096 characters, B1-49).
 * - Read by the camera: a placeholder. Any QR code in view is decoded, also one that has
 *   nothing to do with the visit (a Wi-Fi configuration with its password, a contact card, a
 *   payment or boarding code); its content never leaves the device, since the audit needs the
 *   attempt, not the content.
 */
export function scanPayload(input: string, source: ScanSource = 'keyboard'): string {
  const token = parsePassToken(input)
  if (token) return token
  return source === 'camera' ? UNRECOGNISED_QR_PLACEHOLDER : input.trim().slice(0, SCAN_INPUT_MAX_LENGTH)
}

function checkInBody(action: Extract<ScanAction, { type: 'check-in' }>, submission: ScanSubmission): CheckInRequest {
  switch (action.method) {
    case 'QR':
      return { method: 'QR', pass_token: submission.payload }
    case 'MANUAL':
      return { method: 'MANUAL' }
    case 'OVERRIDE':
      return { method: 'OVERRIDE', reason: action.reason.trim() }
  }
}

export interface ScanStationOptions {
  /** The Scan tab is shown: the camera may auto-start and frames are decoded. */
  scanTabActive: boolean
  /** The decoder preload started when the screen mounted (§10). */
  decoder: DecoderPreloadState
  /** The camera read a pass that is now being checked (e.g. to close the visitor search over the result). */
  onCameraScan?: () => void
}

export interface ScanStation {
  phase: ScannerPhase
  flow: FlowState
  camera: CameraControls
  /** Ref callback for the preview `<video>`. */
  setVideo: (video: HTMLVideoElement | null) => void
  /** A pass typed, pasted or read by a handheld scanner. Returns whether it was taken. */
  submitInput: (input: string) => boolean
  act: (action: ScanAction) => void
  /**
   * The primary action the result panel shows (§10 "Enter triggers the primary action"). It is
   * passed in, not worked out again here, so a key never does other than what is on screen
   * (the 5-minute check-out rule depends on the time).
   */
  actPrimary: (primary: PrimaryAction | null) => void
  /** Leave the result (or the success state) and scan the next pass. */
  dismiss: () => void
  /**
   * Leave a shown result whose visit was just changed elsewhere on the screen (a list or the
   * visitor search checked the visitor in or out): its actions no longer apply.
   */
  dismissIfAbout: (changed: (visit: Visit) => boolean) => void
  /** Send the shown result's input again (no verdict, or the visit changed meanwhile). */
  retry: () => void
  successFeedback: boolean
  setSuccessFeedback: (enabled: boolean) => void
}

/**
 * The reception scanner (§10): camera, decoder, de-duplication and the pass flow in one place.
 *
 * - One `/reception/scan` per detection: a detection is taken only while scanning (decoding is
 *   paused while a result is shown), and the same pass is ignored for 5 s, measured again when
 *   scanning resumes, so a visitor still holding up the code does not trigger it twice.
 * - After a successful action the success state shows for about 1.5 s, then scanning resumes
 *   without a tap.
 */
export function useScanStation({ scanTabActive, decoder, onCameraScan }: ScanStationOptions): ScanStation {
  const [flow, dispatch] = useReducer(scanFlowReducer, INITIAL_FLOW)
  // The flow as event handlers must see it: a detection and an answer can arrive before React renders.
  const flowRef = useRef<FlowState>(flow)
  const apply = useCallback((event: FlowEvent) => {
    flowRef.current = scanFlowReducer(flowRef.current, event)
    dispatch(event)
  }, [])

  const [gate] = useState(createRepeatGate)
  const sequence = useRef(0)
  const scan = useScanPass()
  const checkIn = useCheckIn()
  const checkOut = useCheckOut()

  const [detectorFailed, setDetectorFailed] = useState(false)
  const decoderUnavailable = decoder.status === 'error' || detectorFailed
  const camera = useCameraStream({
    autoStart: scanTabActive,
    blockedBy: decoderUnavailable ? CAMERA_ERRORS['decoder-unavailable'] : null,
  })
  const phase = scannerPhase(flow, camera.status)
  const [video, setVideo] = useState<HTMLVideoElement | null>(null)

  const [successFeedback, setSuccessFeedbackState] = useState(readSuccessFeedback)
  const feedbackRef = useRef(successFeedback)
  const onCameraScanRef = useRef(onCameraScan)
  useEffect(() => {
    feedbackRef.current = successFeedback
    onCameraScanRef.current = onCameraScan
  })

  const { mutateAsync: requestScan } = scan
  const submit = useCallback(
    (input: string, source: ScanSource): boolean => {
      const trimmed = input.trim()
      if (!trimmed || !acceptsSubmission(flowRef.current, source)) return false
      // Every pass is recorded, so the camera ignores one just entered by hand; only camera
      // detections are dropped as repeats, a pass entered on purpose is always checked.
      const admitted = gate.admit(detectionKey(trimmed), Date.now())
      if (source === 'camera' && !admitted) return false
      sequence.current += 1
      const submission: ScanSubmission = { id: sequence.current, payload: scanPayload(trimmed, source), source }
      apply({ type: 'submitted', submission })
      if (source === 'camera') onCameraScanRef.current?.()
      requestScan({ token: submission.payload }).then(
        (result) => apply({ type: 'scanned', submissionId: submission.id, outcome: outcomeFromScanResult(result), at: Date.now() }),
        (error: unknown) => apply({ type: 'scanned', submissionId: submission.id, outcome: outcomeFromScanError(error), at: Date.now() }),
      )
      return true
    },
    [apply, gate, requestScan],
  )

  const decode = useQrDecodeLoop({
    video,
    active: phase === 'scanning' && scanTabActive,
    onDecode: (rawValue) => {
      submit(rawValue, 'camera')
    },
  })
  if (decode.failed && !detectorFailed) setDetectorFailed(true)

  // Scanning resumed after a result: the pass just handled stays ignored for another 5 s.
  useEffect(() => {
    if (phase === 'scanning') gate.refresh(Date.now())
  }, [phase, gate])

  // §10 success: ≈1.5 s, then back to scanning without a tap.
  useEffect(() => {
    if (flow.step !== 'success') return
    const timer = window.setTimeout(() => apply({ type: 'success-elapsed' }), SUCCESS_DISPLAY_MS)
    return () => window.clearTimeout(timer)
  }, [flow, apply])

  const { mutateAsync: requestCheckIn } = checkIn
  const { mutateAsync: requestCheckOut } = checkOut
  const act = useCallback(
    (action: ScanAction) => {
      const current = flowRef.current
      if (current.step !== 'result' || !actionAllowed(current.outcome, action)) return
      const visit = outcomeVisit(current.outcome)
      if (!visit) return
      // The click is the user gesture browsers require before audio may play.
      if (feedbackRef.current) primeSuccessFeedback()
      apply({ type: 'action-started', action })
      const request =
        action.type === 'check-in'
          ? requestCheckIn({ visitId: visit.id, body: checkInBody(action, current.submission) })
          : requestCheckOut({ visitId: visit.id, body: { method: 'QR', pass_token: current.submission.payload } })
      request.then(
        (updated) => {
          apply({ type: 'action-succeeded', visit: updated })
          if (feedbackRef.current) playSuccessFeedback()
        },
        (error: unknown) => apply({ type: 'action-failed', error }),
      )
    },
    [apply, requestCheckIn, requestCheckOut],
  )

  const actPrimary = useCallback(
    (primary: PrimaryAction | null) => {
      if (primary === 'check-in') act({ type: 'check-in', method: 'QR' })
      else if (primary === 'check-out') act({ type: 'check-out', method: 'QR' })
    },
    [act],
  )

  const dismiss = useCallback(() => apply({ type: 'dismissed' }), [apply])

  const dismissIfAbout = useCallback(
    (changed: (visit: Visit) => boolean) => {
      const current = flowRef.current
      if (current.step !== 'result') return
      const visit = outcomeVisit(current.outcome)
      if (visit && changed(visit)) apply({ type: 'dismissed' })
    },
    [apply],
  )

  const retry = useCallback(() => {
    const current = flowRef.current
    if (current.step !== 'result') return
    submit(current.submission.payload, 'keyboard')
  }, [submit])

  const submitInput = useCallback((input: string) => submit(input, 'keyboard'), [submit])

  const setSuccessFeedback = useCallback((enabled: boolean) => {
    storeSuccessFeedback(enabled)
    if (enabled) primeSuccessFeedback()
    setSuccessFeedbackState(enabled)
  }, [])

  return {
    phase,
    flow,
    camera,
    setVideo,
    submitInput,
    act,
    actPrimary,
    dismiss,
    dismissIfAbout,
    retry,
    successFeedback,
    setSuccessFeedback,
  }
}
