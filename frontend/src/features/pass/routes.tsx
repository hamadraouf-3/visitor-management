import type { FeatureModule } from '../types'

export const passFeature: FeatureModule = {
  publicRoutes: [
    {
      path: 'pass',
      // Separate chunk: visitors only download the pass page and the QR encoder (§10).
      lazy: async () => ({ Component: (await import('../../pages/PassPage')).default }),
    },
  ],
}
