import { useEffect, useState } from 'react'
import type { QrCode } from './QrCode'

export type QrCodeComponent = typeof QrCode

export type LazyQrCode =
  | { status: 'loading' }
  | { status: 'ready'; QrCode: QrCodeComponent }
  | { status: 'error' }

let loaded: QrCodeComponent | null = null

function loadQrCode(): Promise<QrCodeComponent> {
  return import('./QrCode').then((module) => {
    loaded = module.QrCode
    return module.QrCode
  })
}

/**
 * The QR renderer, loaded on first use: the `qrcode` encoder stays out of the main bundle
 * (screens that show a pass are rare). State instead of Suspense, so callers know when the
 * code is on screen, e.g. before printing a pass.
 */
export function useLazyQrCode(): LazyQrCode {
  const [state, setState] = useState<LazyQrCode>(() => (loaded ? { status: 'ready', QrCode: loaded } : { status: 'loading' }))

  useEffect(() => {
    if (state.status !== 'loading') return
    let active = true
    loadQrCode().then(
      (QrCode) => {
        if (active) setState({ status: 'ready', QrCode })
      },
      (error: unknown) => {
        console.error('QR code renderer failed to load', error)
        if (active) setState({ status: 'error' })
      },
    )
    return () => {
      active = false
    }
  }, [state.status])

  return state
}
