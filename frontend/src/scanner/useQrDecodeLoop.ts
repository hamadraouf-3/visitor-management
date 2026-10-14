import { useEffect, useRef, useState } from 'react'
import { createQrDetector, type QrDetector } from './zxing'

/** Pause between two decode attempts: about 6 frames per second is plenty for a held-up code. */
export const DECODE_INTERVAL_MS = 160

/** HTMLMediaElement.HAVE_CURRENT_DATA: a frame is available to decode. */
const HAVE_CURRENT_DATA = 2

export interface UseQrDecodeLoopOptions {
  /** The preview element showing the camera stream; null while it is not on screen. */
  video: HTMLVideoElement | null
  /** Decode only while true (the scanner is in its `scanning` state). */
  active: boolean
  /** Called with the raw text of every decoded code (de-duplication is the caller's). */
  onDecode: (rawValue: string) => void
  intervalMs?: number
}

export interface QrDecodeLoopState {
  /** The decoder could not be created (e.g. the wasm failed to compile). */
  failed: boolean
}

/**
 * Decodes frames of the camera preview while `active`. One detection runs at a time, then the
 * next is scheduled; turning `active` off stops scheduling at once and discards a detection
 * still running, so nothing is reported while a result is shown (§10 de-duplication). The
 * detector (native BarcodeDetector or the self-hosted zxing ponyfill) is created once.
 *
 * No "hold the code steady" hint after a while without a decode any more (the user's request 8:
 * no explanatory notes): the timer ran whenever nobody stood at the camera, so the yellow hint
 * was on screen for most of an idle day. The camera's errors stay.
 */
export function useQrDecodeLoop({ video, active, onDecode, intervalMs = DECODE_INTERVAL_MS }: UseQrDecodeLoopOptions): QrDecodeLoopState {
  const [detector, setDetector] = useState<QrDetector | null>(null)
  const [failed, setFailed] = useState(false)
  const onDecodeRef = useRef(onDecode)
  useEffect(() => {
    onDecodeRef.current = onDecode
  })

  const wanted = active && video !== null
  const [requested, setRequested] = useState(false)
  if (wanted && !requested) setRequested(true)

  // Created on first use (the preload on mount already fetched and compiled the wasm).
  useEffect(() => {
    if (!requested) return
    let cancelled = false
    createQrDetector().then(
      ({ detector: created }) => {
        if (!cancelled) setDetector(created)
      },
      (error: unknown) => {
        console.warn('QR detector could not be created', error)
        if (!cancelled) setFailed(true)
      },
    )
    return () => {
      cancelled = true
    }
  }, [requested])

  const running = wanted && detector !== null

  useEffect(() => {
    if (!running || !video || !detector) return
    let stopped = false
    let timer: number | undefined
    let warned = false

    const tick = async () => {
      if (stopped) return
      if (video.readyState >= HAVE_CURRENT_DATA && video.videoWidth !== 0) {
        try {
          const codes = await detector.detect(video)
          const rawValue = codes.find((code) => code.rawValue)?.rawValue
          if (stopped) return
          if (rawValue) onDecodeRef.current(rawValue)
        } catch (error) {
          // A frame that cannot be read (e.g. while the camera switches) is skipped.
          if (!warned) console.warn('QR decode failed for a frame', error)
          warned = true
        }
      }
      if (!stopped) timer = window.setTimeout(() => void tick(), intervalMs)
    }
    void tick()
    return () => {
      stopped = true
      window.clearTimeout(timer)
    }
  }, [running, video, detector, intervalMs])

  return { failed }
}
