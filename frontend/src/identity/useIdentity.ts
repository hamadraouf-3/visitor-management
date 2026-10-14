import { queryOptions, useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { useLocation } from 'react-router'
import { getPublicBrand } from '../api/publicBrand'
import { queryKeys } from '../api/queryKeys'
import { useCachedMe } from '../auth/useAuth'
import { productName } from '../brand'
import { useLanguage } from '../i18n/useLanguage'
import { areaOf, identityName, needsPublicBrand, resolveIdentity, type ResolvedIdentity } from './identity'
import { readCachedBrand, readRememberedCompany } from './storage'

/** The one request for a company's public brand: the page's query, and the boot's before the first render (`boot.ts`). */
export function publicBrandQuery(slug: string) {
  return queryOptions({
    queryKey: queryKeys.publicBrand(slug),
    queryFn: ({ signal }) => getPublicBrand(slug, { signal }),
    staleTime: 5 * 60_000,
    retry: false,
  })
}

/**
 * The public brand of a company by slug (null: asks nothing). It starts from this device's copy,
 * which is checked against the server at once, so a company's sign-in page and a visitor's pass
 * open in their identity. A slug nobody has answers null.
 */
export function usePublicBrand(slug: string | null) {
  return useQuery({
    ...publicBrandQuery(slug ?? ''),
    enabled: slug !== null,
    // Shown at once and stale from the start: the server's answer replaces it.
    initialData: () => readCachedBrand(slug) ?? undefined,
    initialDataUpdatedAt: 0,
    refetchOnWindowFocus: false,
  })
}

/**
 * Whose identity this page shows (see `resolveIdentity`): the product's in the platform owner's
 * area, the session's company, the company the address names, or none. It reads the session from
 * the cache without asking for it, and asks the public brand endpoint only for a company an address
 * names while nobody is signed in (always on the visitor's pass). Any component may call it: the
 * answers are shared through the query cache.
 */
export function useIdentity(): ResolvedIdentity {
  const { pathname, search } = useLocation()
  const me = useCachedMe()
  const slug = needsPublicBrand({ pathname, search, me })
  const query = usePublicBrand(slug)
  // An answer, or this device's copy while it is on its way; a failed request without a copy is the neutral page.
  const publicBrand = slug === null ? undefined : query.data !== undefined ? query.data : query.isError ? null : undefined
  const wantsRemembered = me === undefined && slug === null && areaOf(pathname) === 'app'
  const remembered = useMemo(() => (wantsRemembered ? readCachedBrand(readRememberedCompany()) : null), [wantsRemembered])
  return useMemo(() => resolveIdentity({ pathname, search, me, publicBrand, remembered }), [pathname, search, me, publicBrand, remembered])
}

/**
 * The name a page's title ends with (`<page> · <name>`): the company's in the UI language, the
 * product's in the platform owner's area, none on a neutral page.
 */
export function useIdentityName(): string {
  const { identity } = useIdentity()
  const { language } = useLanguage()
  if (identity.kind === 'product') return productName(language)
  if (identity.kind === 'company') return identityName(identity, language)
  return ''
}
