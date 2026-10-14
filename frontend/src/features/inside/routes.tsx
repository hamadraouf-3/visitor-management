import { DoorOpen } from 'lucide-react'
import { RequireRole } from '../../auth/RequireRole'
import { SECTION_ACCESS } from '../../auth/roles'
import { paths } from '../../paths'
import type { FeatureModule } from '../types'

// Lazy pages (separate chunks): the sign-in and pass pages never download them.
export const insideFeature: FeatureModule = {
  routes: [
    {
      element: <RequireRole roles={SECTION_ACCESS.inside} />,
      children: [{ path: 'inside', lazy: async () => ({ Component: (await import('./InsidePage')).InsidePage }) }],
    },
  ],
  nav: [{ to: paths.inside, label: 'Inside now', icon: DoorOpen, roles: SECTION_ACCESS.inside, section: 'main', order: 50 }],
}
