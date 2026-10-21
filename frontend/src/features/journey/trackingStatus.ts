import type { TrackingStatus } from '../../types/api'

/** The deployment's provider name for the development and E2E simulator (`TRACKING_PROVIDER=simulator`). */
export const SIMULATOR_PROVIDER = 'simulator'

export function isSimulatorProvider(provider: string | null | undefined): boolean {
  return provider === SIMULATOR_PROVIDER
}

/** Tracking works for this company now: a provider is configured, and the company is allowed to and has turned it on. */
export function isTrackingOn(status: TrackingStatus | undefined): boolean {
  return status !== undefined && status.available && status.allowed && status.enabled
}

export type TrackingBannerLine = 'noProvider' | 'off' | 'notConnected'

export interface TrackingBanner {
  /** `noProvider`: «لا يوجد مزوّد تتبّع»; `off`: «التتبّع غير مفعّل»; `notConnected`: «مزوّد التتبّع غير متصل»; null: no line. */
  line: TrackingBannerLine | null
  /** The deployment's provider is the simulator: «محاكاة». */
  simulated: boolean
}

/**
 * What the page's one line says. No provider when the deployment has none (`TRACKING_PROVIDER=disabled`,
 * production's value: `available` false); off when the platform owner has not allowed tracking for the
 * company or its administrator has not turned it on; on but without a healthy provider contact: not
 * connected. The simulator is said whenever it is the provider, on or off, so nothing it produced is ever
 * read as real.
 */
export function trackingBanner(status: TrackingStatus): TrackingBanner {
  const simulated = status.available && isSimulatorProvider(status.provider)
  if (!status.available) return { line: 'noProvider', simulated }
  if (!isTrackingOn(status)) return { line: 'off', simulated }
  if (!status.healthy) return { line: 'notConnected', simulated }
  return { line: null, simulated }
}
