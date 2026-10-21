import { Route as RouteIcon } from 'lucide-react'
import { RequireRole } from '../../auth/RequireRole'
import { RequireTrackingAllowed } from '../../auth/RequireTrackingAllowed'
import { SECTION_ACCESS } from '../../auth/roles'
import { paths } from '../../paths'
import type { FeatureModule } from '../types'

/**
 * «رحلة الزائر» / "Visitor Journey" (Phase 15): administrators, management and reception, of a company whose
 * tracking the platform owner allows; hosts get no tab (the API answers them 403). Lazy pages (separate chunks): the sign-in and pass pages never download them.
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
            { path: 'journey/:visitId', lazy: async () => ({ Component: (await import('./JourneyDetailPage')).JourneyDetailPage }) },
          ],
        },
      ],
    },
  ],
  nav: [{ to: paths.journey, label: 'Visitor Journey', icon: RouteIcon, roles: SECTION_ACCESS.journey, section: 'main', order: 55, requiresTracking: true }],
}
