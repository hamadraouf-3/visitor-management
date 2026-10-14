import type { QueryClient } from '@tanstack/react-query'
import { currentScheme } from '../appearance/appearance'
import { applyDocumentIdentity, documentIdentityOf } from './document'
import { needsPublicBrand, resolveIdentity } from './identity'
import { readCachedBrand, readRememberedCompany, writeCachedBrand } from './storage'
import { publicBrandQuery } from './useIdentity'

/**
 * The identity a page starts with, before React renders anything (Phase 12): from the address and
 * this device's copies alone, since neither the session nor the server has answered yet. `main.tsx`
 * applies it, so the first paint is already in the company's colours, with its icon in the tab (and the
 * browser chrome's colour for the scheme the device's appearance draws the page in, Phase 13);
 * `IdentityController` takes over once the app runs. A device that knows no company, and an address
 * that names none, start neutral; a company the device has never seen is asked for first
 * (`primeBootIdentity`).
 */
export function applyBootIdentity(location: Pick<Location, 'pathname' | 'search'> = window.location): void {
  const { pathname, search } = location
  const slug = needsPublicBrand({ pathname, search, me: undefined })
  const { identity, pending } = resolveIdentity({
    pathname,
    search,
    me: undefined,
    publicBrand: slug ? (readCachedBrand(slug) ?? undefined) : undefined,
    remembered: readCachedBrand(readRememberedCompany()),
  })
  // A company this device has never seen: nobody's colours until its own are known (never the default ones first).
  applyDocumentIdentity(document, documentIdentityOf(identity, pathname, pending), currentScheme())
}

/** How long the first render waits, at most, for the identity of a company this device has never seen. */
export const BOOT_IDENTITY_WAIT_MS = 800

/**
 * The first visit of a device to a company's page (a visitor opening a pass, someone following a
 * sign-in link): the device has no copy of the identity, so the page would paint the default
 * colours and change them a moment later. Before the first render, `main.tsx` therefore waits for
 * the public brand: this resolves once the answer is on the document and in the device's memory,
 * or after `waitMs` at the latest (the page then renders without an identity and takes it when it
 * arrives, as on any slow connection). It resolves at once for every other page: an address that
 * names no company, and a company the device has a copy of.
 *
 * The request is the page's own query (`publicBrandQuery`): the first render finds its answer, or
 * joins it while it is on its way, and asks nothing twice.
 */
export function primeBootIdentity(queryClient: QueryClient, location: Pick<Location, 'pathname' | 'search'> = window.location, waitMs: number = BOOT_IDENTITY_WAIT_MS): Promise<void> {
  const { pathname, search } = location
  const slug = needsPublicBrand({ pathname, search, me: undefined })
  if (slug === null || readCachedBrand(slug)) return Promise.resolve()
  return new Promise((resolve) => {
    // Once the page renders, the document's identity is the app's to keep (`IdentityController`).
    let rendering = false
    const start = () => {
      if (rendering) return
      rendering = true
      resolve()
    }
    const timer = setTimeout(start, waitMs)
    queryClient
      .fetchQuery(publicBrandQuery(slug))
      .then((brand) => {
        if (rendering || !brand) return
        writeCachedBrand(brand)
        applyBootIdentity(location)
      })
      // A failed request: the page renders without an identity, and its own query says why.
      .catch(() => undefined)
      .finally(() => {
        clearTimeout(timer)
        start()
      })
  })
}
