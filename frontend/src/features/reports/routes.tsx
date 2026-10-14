import { ChartColumn } from 'lucide-react'
import { RequireRole } from '../../auth/RequireRole'
import { SECTION_ACCESS } from '../../auth/roles'
import { paths } from '../../paths'
import type { FeatureModule } from '../types'

// Lazy pages (separate chunks): the sign-in and pass pages never download them.
export const reportsFeature: FeatureModule = {
  routes: [
    {
      element: <RequireRole roles={SECTION_ACCESS.reports} />,
      children: [{ path: 'reports', lazy: async () => ({ Component: (await import('./ReportsPage')).ReportsPage }) }],
    },
  ],
  nav: [
    { to: paths.reports, label: 'Reports', icon: ChartColumn, roles: SECTION_ACCESS.reports, section: 'insights', order: 70 },
  ],
}
