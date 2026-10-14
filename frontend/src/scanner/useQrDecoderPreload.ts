import { useEffect, useState } from 'react'
import { preloadQrDecoder, type QrDecoderEngine } from './zxing'

export type DecoderPreloadState =
  | { status: 'loading' }
  | { status: 'ready'; engine: QrDecoderEngine }
  | { status: 'error'; error: unknown }

/**
 * Starts loading the QR decoder as soon as the reception screen mounts (§10), so the first
 * scan does not wait for the wasm download/compile. Failures are reported in the state;
 * the scanner UI decides how to present them.
 */
export function useQrDecoderPreload(): DecoderPreloadState {
  const [state, setState] = useState<DecoderPreloadState>({ status: 'loading' })

  useEffect(() => {
    let active = true
    preloadQrDecoder().then(
      (engine) => {
        if (active) setState({ status: 'ready', engine })
      },
      (error: unknown) => {
        console.warn('QR decoder preload failed', error)
        if (active) setState({ status: 'error', error })
      },
    )
    return () => {
      active = false
    }
  }, [])

  return state
}
