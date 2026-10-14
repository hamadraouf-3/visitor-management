import { useEffect, useLayoutEffect, useMemo } from 'react'
import { useLocation } from 'react-router'
import { useColorScheme } from '../appearance/useAppearance'
import { useCachedMe } from '../auth/useAuth'
import { applyLanguage } from '../i18n'
import { browserLanguage, DEFAULT_LANGUAGE, readStoredLanguage } from '../i18n/languages'
import { companyDefaultLanguageOf } from '../i18n/session'
import { applyDocumentIdentity, documentIdentityOf, type DocumentIdentity } from './document'
import { identityOfSession, needsPublicBrand } from './identity'
import { dropCachedBrand, forgetCompany, rememberCompany, writeCachedBrand } from './storage'
import { useIdentity, usePublicBrand } from './useIdentity'

/**
 * Keeps the document in the page's identity (Phase 12) and this device's memory of it. Mounted once,
 * in `RootLayout`:
 *
 * - the palette's custom properties, the browser chrome's colour (in the scheme the device's appearance
 *   draws the page in, Phase 13), the tab's icon and the manifest follow the identity, before the browser paints the change, and without a colour transition; a
 *   company that is still on its way is drawn in nobody's colours until then;
 * - a signed-in session's company is remembered as the device's company, with its identity, so the
 *   next load starts in it and `/login`, a sign-out and an expired session lead to its sign-in page;
 * - a public brand the server answered is kept for the next load; a slug nobody has is forgotten.
 */
export function IdentityController(): null {
  const { pathname, search } = useLocation()
  const me = useCachedMe()
  const { identity, pending } = useIdentity()
  const scheme = useColorScheme()
  const slug = needsPublicBrand({ pathname, search, me })
  const { data: publicBrand, dataUpdatedAt } = usePublicBrand(slug)

  const signature = JSON.stringify(documentIdentityOf(identity, pathname, pending))
  const head = useMemo(() => JSON.parse(signature) as DocumentIdentity, [signature])
  useLayoutEffect(() => {
    applyDocumentIdentity(document, head, scheme)
  }, [head, scheme])

  useEffect(() => {
    if (!me) return
    const session = identityOfSession(me)
    if (!session.slug) return
    rememberCompany(session.slug)
    writeCachedBrand({
      slug: session.slug,
      name: session.name,
      name_ar: session.nameAr,
      default_language: companyDefaultLanguageOf(me) ?? DEFAULT_LANGUAGE,
      brand: session.brand,
    })
  }, [me])

  useEffect(() => {
    // `dataUpdatedAt` 0: this device's copy, not yet the server's answer.
    if (slug === null || dataUpdatedAt === 0 || publicBrand === undefined) return
    if (publicBrand === null) {
      dropCachedBrand(slug)
      forgetCompany(slug)
      return
    }
    writeCachedBrand(publicBrand)
    // A device that has chosen no language and whose browser speaks neither: the company's own.
    if (readStoredLanguage() === null && browserLanguage() === null) applyLanguage(publicBrand.default_language)
  }, [slug, publicBrand, dataUpdatedAt])

  return null
}
