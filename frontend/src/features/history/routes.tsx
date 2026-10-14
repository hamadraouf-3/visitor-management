import { FileClock } from 'lucide-react'
import { RequireRole } from '../../auth/RequireRole'
import { SECTION_ACCESS } from '../../auth/roles'
import { paths } from '../../paths'
import type { FeatureModule } from '../types'

// Lazy pages (separate chunks): the sign-in and pass pages never download them.
export const historyFeature: FeatureModule = {
  routes: [
    {
      element: <RequireRole roles={SECTION_ACCESS.history} />,
      children: [{ path: 'history', lazy: async () => ({ Component: (await import('./HistoryPage')).HistoryPage }) }],
    },
  ],
  nav: [
    { to: paths.history, label: 'Visit history', icon: FileClock, roles: SECTION_ACCESS.history, section: 'main', order: 60 },
  ],
}
