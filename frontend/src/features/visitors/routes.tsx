import { Contact } from 'lucide-react'
import { RequireRole } from '../../auth/RequireRole'
import { SECTION_ACCESS } from '../../auth/roles'
import { paths } from '../../paths'
import type { FeatureModule } from '../types'

// Lazy pages (separate chunks): the sign-in and pass pages never download them.
export const visitorsFeature: FeatureModule = {
  routes: [
    {
      element: <RequireRole roles={SECTION_ACCESS.visitors} />,
      children: [
        { path: 'visitors', lazy: async () => ({ Component: (await import('../../pages/VisitorsPage')).VisitorsPage }) },
        {
          path: 'visitors/:visitorId',
          lazy: async () => ({ Component: (await import('../../pages/VisitorProfilePage')).VisitorProfilePage }),
        },
      ],
    },
  ],
  nav: [{ to: paths.visitors, label: 'Visitors', icon: Contact, roles: SECTION_ACCESS.visitors, section: 'main', order: 40 }],
}
