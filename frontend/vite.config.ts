/// <reference types="vitest/config" />
import basicSsl from '@vitejs/plugin-basic-ssl'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv, type ProxyOptions } from 'vite'
import { SECURITY_HEADERS } from './config/securityHeaders.ts'
import { serviceWorkerPrecache } from './config/serviceWorkerPrecache.ts'

const DEFAULT_API_TARGET = 'http://localhost:8000'

/**
 * Source modules of the app shell's own chunk: the app's scripts (src/, not a library) except
 * the entry (main.tsx) and the route tables (router.tsx, features/<name>/routes.tsx), which
 * `import()` the lazy pages and so name their chunks. The stylesheet stays with the entry too:
 * a chunk's file name also covers its CSS, and the one Tailwind stylesheet changes with any page.
 */
export function isAppShellModule(id: string): boolean {
  if (/[\\/]node_modules[\\/]/.test(id) || !/[\\/]src[\\/].+\.[jt]sx?$/.test(id)) return false
  return !/[\\/]src[\\/](?:main|router)\.tsx$|[\\/]src[\\/]features[\\/][^\\/]+[\\/]routes\.tsx$/.test(id)
}

export default defineConfig(({ mode }) => {
  // VMS_API_PROXY_TARGET lets automated runs (E2E) point the proxy at a backend on its own port.
  // It is not VITE_-prefixed, so it never reaches client code.
  const env = loadEnv(mode, process.cwd(), '')
  const apiProxy: Record<string, ProxyOptions> = {
    '/api': {
      target: env.VMS_API_PROXY_TARGET || DEFAULT_API_TARGET,
      // Adds X-Forwarded-For/-Proto/-Host; the backend only trusts them from TRUSTED_PROXIES (§7.3).
      xfwd: true,
    },
  }

  return {
    plugins: [
      react(),
      tailwindcss(),
      serviceWorkerPrecache(),
      // `npm run dev:https`: camera access from LAN tablets requires a secure context (§2).
      ...(mode === 'https' ? [basicSsl()] : []),
    ],
    // The SPA calls /api same-origin through the proxy (§3: no CORS anywhere). Vite's default
    // CORS middleware would answer other localhost origins and preflights for the proxied API.
    server: {
      port: 5173,
      strictPort: true,
      cors: false,
      proxy: apiProxy,
    },
    preview: {
      port: 4173,
      strictPort: true,
      cors: false,
      proxy: apiProxy,
      headers: SECURITY_HEADERS,
    },
    build: {
      rolldownOptions: {
        output: {
          // The libraries change far less often than the app: in chunks of their own they stay
          // cached across deployments (and the service worker precache), instead of being
          // downloaded again with every app change.
          codeSplitting: {
            groups: [
              { name: 'react', test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
              { name: 'router', test: /node_modules[\\/]react-router[\\/]/ },
              { name: 'query', test: /node_modules[\\/]@tanstack[\\/]/ },
              { name: 'dates', test: /node_modules[\\/](date-fns|@date-fns)[\\/]/ },
              { name: 'icons', test: /node_modules[\\/]lucide-react[\\/]/ },
              // The app shell (everything the entry loads at start) apart from the route tables,
              // which hold the lazy pages' file names. Pages import shared code from this chunk,
              // never from the entry: a changed page then changes only its own chunk and the
              // entry, instead of renaming every page chunk (each one imports the entry by its
              // hashed name) and making browsers and the service worker download them all again.
              { name: 'app', test: isAppShellModule, tags: ['$initial'] },
            ],
          },
        },
      },
    },
    test: {
      environment: 'jsdom',
      setupFiles: ['./src/test/setup.ts'],
      // Page tests run long flows (several fields, dialogs, refetches) beside many other files:
      // room for a loaded machine. `asyncUtilTimeout` is set in the setup file.
      testTimeout: 20_000,
      include: ['src/**/*.test.{ts,tsx}', 'config/**/*.test.ts'],
      restoreMocks: true,
      unstubGlobals: true,
      unstubEnvs: true,
      // The browser timezone deliberately differs from every company timezone used in tests.
      env: { TZ: 'UTC' },
      coverage: {
        provider: 'v8',
        include: ['src/**/*.{ts,tsx}'],
        exclude: ['src/**/*.test.{ts,tsx}', 'src/test/**', 'src/main.tsx'],
      },
    },
  }
})
