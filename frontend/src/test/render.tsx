import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactElement } from 'react'
import { I18nextProvider } from 'react-i18next'
import { createBrowserRouter, createMemoryRouter, type InitialEntry, type RouteObject } from 'react-router'
import { RouterProvider } from 'react-router/dom'
import { createQueryCache } from '../api/queryClient'
import { ToastProvider } from '../components/ui/Toast'
import { i18n } from '../i18n'

type AppRouter = ReturnType<typeof createMemoryRouter>

const activeRouters = new Set<AppRouter>()

/** Called after each test: routers keep history listeners until disposed. */
export function disposeRouters(): void {
  for (const router of activeRouters) router.dispose()
  activeRouters.clear()
}

export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    // The app's cache policy (refused refetches drop their data), with the test defaults below.
    queryCache: createQueryCache(),
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  })
}

function renderRouter(router: AppRouter, queryClient: QueryClient) {
  activeRouters.add(router)
  const user = userEvent.setup({ delay: null })
  const view = render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <RouterProvider router={router} />
        </ToastProvider>
      </QueryClientProvider>
    </I18nextProvider>,
  )
  return { ...view, router, queryClient, user }
}

/** Renders a route tree in a memory router with the app's providers. */
export function renderRoutes(
  routes: RouteObject[],
  { initialEntries = ['/'], queryClient = createTestQueryClient() }: { initialEntries?: InitialEntry[]; queryClient?: QueryClient } = {},
) {
  return renderRouter(createMemoryRouter(routes, { initialEntries }), queryClient)
}

/**
 * Renders a route tree in a browser router bound to jsdom's real `window.location` and
 * `history` (for behavior that reads or rewrites the address bar). Set the URL first with
 * `window.history.replaceState`.
 */
export function renderBrowserRoutes(routes: RouteObject[], { queryClient = createTestQueryClient() } = {}) {
  return renderRouter(createBrowserRouter(routes), queryClient)
}

/**
 * The `role="alert"` element containing `text`. The toast region keeps an empty assertive
 * live region mounted at all times, so `findByRole('alert')` alone is ambiguous.
 */
export async function findAlert(text: string): Promise<HTMLElement> {
  return waitFor(() => {
    const match = screen.getAllByRole('alert').find((element) => element.textContent?.includes(text))
    if (!match) throw new Error(`No alert containing "${text}"`)
    return match
  })
}

/**
 * Every address (path + query) the router shows from now on, including ones replaced at once.
 * A browser records each of them in its saved history, so "never in the address" means none.
 */
export function recordAddresses(router: AppRouter): string[] {
  const seen: string[] = []
  router.subscribe((state) => seen.push(`${state.location.pathname}${state.location.search}`))
  return seen
}

/** Renders a single element at "/" (for components that need router context). */
export function renderWithProviders(element: ReactElement, options: { initialEntries?: InitialEntry[]; queryClient?: QueryClient } = {}) {
  return renderRoutes([{ path: '*', element }], options)
}
