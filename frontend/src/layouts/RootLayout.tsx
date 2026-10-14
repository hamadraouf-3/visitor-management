import { Outlet, ScrollRestoration } from 'react-router'
import { AuthProvider } from '../auth/AuthProvider'
import { IdentityController } from '../identity/IdentityController'
import { LanguageController } from '../i18n/useLanguage'

/**
 * Top-level route element: global auth reactions, the session's language (`LanguageController`),
 * the page's identity on the document (`IdentityController`, Phase 12) and scroll restoration for
 * every page.
 */
export function RootLayout() {
  return (
    <AuthProvider>
      <LanguageController />
      <IdentityController />
      <Outlet />
      <ScrollRestoration />
    </AuthProvider>
  )
}
