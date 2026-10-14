import { createBrowserRouter, type RouteObject } from 'react-router'
import { LandingRedirect } from './auth/LandingRedirect'
import { RequireAuth } from './auth/RequireAuth'
import { PageErrorBoundary, RootErrorBoundary } from './components/app/RouteErrorBoundary'
import { FullPageLoader } from './components/app/StatusScreens'
import { adminFeature } from './features/admin/routes'
import { authFeature } from './features/auth/routes'
import { historyFeature } from './features/history/routes'
import { insideFeature } from './features/inside/routes'
import { passFeature } from './features/pass/routes'
import { platformFeature } from './features/platform/routes'
import { receptionFeature } from './features/reception/routes'
import { reportsFeature } from './features/reports/routes'
import type { FeatureModule, NavEntry } from './features/types'
import { visitorsFeature } from './features/visitors/routes'
import { visitsFeature } from './features/visits/routes'
import { AppLayout } from './layouts/AppLayout'
import { RootLayout } from './layouts/RootLayout'
import { NotFoundPage } from './pages/NotFoundPage'

/** Every feature module. Features own their routes and navigation; this file only composes. */
const features: readonly FeatureModule[] = [
  authFeature,
  passFeature,
  receptionFeature,
  visitsFeature,
  visitorsFeature,
  insideFeature,
  historyFeature,
  reportsFeature,
  adminFeature,
  // The platform owner's area (Phase 11): public routes with a session, guard and shell of their own.
  platformFeature,
]

export const navigation: readonly NavEntry[] = features
  .flatMap((feature) => feature.nav ?? [])
  .toSorted((a, b) => a.order - b.order)

export const routes: RouteObject[] = [
  {
    path: '/',
    Component: RootLayout,
    HydrateFallback: FullPageLoader,
    ErrorBoundary: RootErrorBoundary,
    children: [
      ...features.flatMap((feature) => feature.publicRoutes ?? []),
      {
        Component: RequireAuth,
        children: [
          {
            element: <AppLayout navigation={navigation} />,
            children: [
              {
                // Errors inside a page render within the layout, so navigation stays usable.
                ErrorBoundary: PageErrorBoundary,
                children: [{ index: true, Component: LandingRedirect }, ...features.flatMap((feature) => feature.routes ?? [])],
              },
            ],
          },
        ],
      },
      { path: '*', Component: NotFoundPage },
    ],
  },
]

export function createAppRouter() {
  return createBrowserRouter(routes)
}
