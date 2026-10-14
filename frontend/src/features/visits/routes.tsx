import { CalendarDays, UserPlus } from 'lucide-react'
import { RequireRole } from '../../auth/RequireRole'
import { SECTION_ACCESS } from '../../auth/roles'
import { paths } from '../../paths'
import type { FeatureModule } from '../types'

// Lazy pages (separate chunks): the sign-in and pass pages never download them.
export const visitsFeature: FeatureModule = {
  routes: [
    {
      element: <RequireRole roles={SECTION_ACCESS.myVisits} />,
      children: [{ path: 'visits', lazy: async () => ({ Component: (await import('../../pages/MyVisitsPage')).MyVisitsPage }) }],
    },
    {
      element: <RequireRole roles={SECTION_ACCESS.inviteVisitor} />,
      children: [
        { path: 'visits/new', lazy: async () => ({ Component: (await import('../../pages/InviteVisitorPage')).InviteVisitorPage }) },
      ],
    },
    {
      element: <RequireRole roles={SECTION_ACCESS.visitDetail} />,
      children: [
        { path: 'visits/:visitId', lazy: async () => ({ Component: (await import('../../pages/VisitDetailPage')).VisitDetailPage }) },
      ],
    },
  ],
  nav: [
    {
      to: paths.myVisits,
      label: 'My visits',
      icon: CalendarDays,
      roles: SECTION_ACCESS.myVisits,
      section: 'main',
      order: 20,
      end: true,
    },
    {
      to: paths.inviteVisitor,
      label: 'Invite visitor',
      icon: UserPlus,
      roles: SECTION_ACCESS.inviteVisitor,
      section: 'main',
      order: 30,
    },
  ],
}
