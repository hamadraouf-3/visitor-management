import { matchPath } from 'react-router'
import { paths } from '../paths'

/**
 * Whether a page opened at `pathname` installs the service worker: every page except the
 * visitor's pass. The worker precaches the whole staff app, the QR decoder's wasm included;
 * a visitor opening their pass on a phone must not download it. A device that already has the
 * worker (a staff member's) keeps it on every page.
 */
export function shouldRegisterServiceWorker(pathname: string): boolean {
  return matchPath(paths.pass, pathname) === null
}

/**
 * Registers `public/sw.js` in production builds only (§10): in development a worker would
 * serve stale modules and fight Vite's HMR. `updateViaCache: 'none'` makes the browser
 * check the worker and its imported precache manifest on every navigation, so a new
 * deploy is picked up promptly.
 */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return
  if (!shouldRegisterServiceWorker(window.location.pathname)) return
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' }).catch((error: unknown) => {
      console.error('Service worker registration failed', error)
    })
  })
}
