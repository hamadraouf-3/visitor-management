import { ScanLine } from 'lucide-react'
import { RequireRole } from '../../auth/RequireRole'
import { SECTION_ACCESS } from '../../auth/roles'
import { DARK_SURFACE_HANDLE } from '../../layouts/shellSurface'
import { paths } from '../../paths'
import type { FeatureModule } from '../types'

export const receptionFeature: FeatureModule = {
  routes: [
    {
      element: <RequireRole roles={SECTION_ACCESS.reception} />,
      children: [
        {
          path: 'reception',
          // Direction C's reception tablet: dark from edge to edge (the deep shell, dark tokens for
          // the page and everything it opens on top of itself).
          handle: DARK_SURFACE_HANDLE,
          // Separate chunk: the scanner and QR decoder are only downloaded by reception users.
          lazy: async () => ({ Component: (await import('./ReceptionPage')).default }),
        },
      ],
    },
  ],
  nav: [
    { to: paths.reception, label: 'Reception', icon: ScanLine, roles: SECTION_ACCESS.reception, section: 'main', order: 10 },
  ],
}
