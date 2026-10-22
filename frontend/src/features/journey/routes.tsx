import { BellRing, Route as RouteIcon } from 'lucide-react'
import { RequireRole } from '../../auth/RequireRole'
import { RequireTrackingAllowed } from '../../auth/RequireTrackingAllowed'
import { SECTION_ACCESS } from '../../auth/roles'
import { paths } from '../../paths'
import type { FeatureModule } from '../types'
import { TrackingAlertsNavBadge } from './alerts/TrackingAlertsNavBadge'
import { TrackingAlertWatcher } from './alerts/TrackingAlertWatcher'

/**
 * «رحلة الزائر» / "Visitor Journey": administrators, management and reception, of a company whose tracking the
 * platform owner allows; hosts get no tab (the API answers them 403). Lazy pages (separate chunks): the sign-in
 * and pass pages never download them. Phase 16: «تنبيهات التتبّع» / "Tracking alerts" (/journey/alerts, its
 * entry with the active count), and the shell's watcher that polls the alerts and tells of new ones.
 */
export const journeyFeature: FeatureModule = {
  routes: [
    {
      element: <RequireRole roles={SECTION_ACCESS.journey} />,
      children: [
        {
          // Only while the platform owner allows the company's tracking (the lead's decision, F15-1).
          element: <RequireTrackingAllowed />,
          children: [
            { path: 'journey', lazy: async () => ({ Component: (await import('./JourneyPage')).JourneyPage }) },
            // A static segment: ranked before a visit's id.
            { path: 'journey/alerts', lazy: async () => ({ Component: (await import('./alerts/TrackingAlertsPage')).TrackingAlertsPage }) },
            { path: 'journey/:visitId', lazy: async () => ({ Component: (await import('./JourneyDetailPage')).JourneyDetailPage }) },
          ],
        },
      ],
    },
  ],
  nav: [
    { to: paths.journey, label: 'Visitor Journey', icon: RouteIcon, roles: SECTION_ACCESS.journey, section: 'main', order: 55, requiresTracking: true },
    { to: paths.journeyAlerts, label: 'Tracking alerts', icon: BellRing, roles: SECTION_ACCESS.journey, section: 'main', order: 56, requiresTracking: true, badge: TrackingAlertsNavBadge },
  ],
  shell: [{ id: 'tracking-alerts', component: TrackingAlertWatcher, roles: SECTION_ACCESS.journey, requiresTracking: true }],
}
