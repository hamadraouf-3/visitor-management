import { Navigate } from 'react-router'
import { PageErrorBoundary } from '../../components/app/RouteErrorBoundary'
import { paths } from '../../paths'
import type { FeatureModule } from '../types'

/**
 * The platform owner's area (Phase 11): `/platform/…`, outside the company app's `RequireAuth` and
 * shell. It has its own session (`PlatformRoot`), guard (`RequirePlatformAuth`: a company session
 * does not count, so a company user who opens it sees the platform sign-in) and shell
 * (`PlatformLayout`). Every module is lazy: a company user's browser never downloads it.
 */
export const platformFeature: FeatureModule = {
  publicRoutes: [
    {
      path: 'platform',
      lazy: async () => ({ Component: (await import('./PlatformRoot')).PlatformRoot }),
      children: [
        { path: 'login', lazy: async () => ({ Component: (await import('./PlatformLoginPage')).PlatformLoginPage }) },
        {
          lazy: async () => ({ Component: (await import('./RequirePlatformAuth')).RequirePlatformAuth }),
          children: [
            {
              lazy: async () => ({ Component: (await import('./PlatformLayout')).PlatformLayout }),
              children: [
                {
                  // Errors inside a page render within the shell, so its navigation stays usable.
                  ErrorBoundary: PageErrorBoundary,
                  children: [
                    { index: true, element: <Navigate to={paths.platformCompanies} replace /> },
                    {
                      path: 'change-password',
                      lazy: async () => ({ Component: (await import('./PlatformChangePasswordPage')).PlatformChangePasswordPage }),
                    },
                    { path: 'companies', lazy: async () => ({ Component: (await import('./CompaniesPage')).CompaniesPage }) },
                    { path: 'companies/new', lazy: async () => ({ Component: (await import('./NewCompanyPage')).NewCompanyPage }) },
                    { path: 'companies/:companyId', lazy: async () => ({ Component: (await import('./CompanyPage')).CompanyPage }) },
                    // Phase 12: a company's identity (logo, colour, sign-in link) and its e-mail texts, edited by the platform owner.
                    { path: 'companies/:companyId/identity', lazy: async () => ({ Component: (await import('./CompanyIdentityPage')).CompanyIdentityPage }) },
                    {
                      path: 'companies/:companyId/email-templates',
                      lazy: async () => ({ Component: (await import('./CompanyEmailTemplatesPage')).CompanyEmailTemplatesPage }),
                    },
                    {
                      path: 'companies/:companyId/email-templates/:kind',
                      lazy: async () => ({ Component: (await import('./CompanyEmailTemplatePage')).CompanyEmailTemplatePage }),
                    },
                    { path: 'audit', lazy: async () => ({ Component: (await import('./PlatformAuditPage')).PlatformAuditPage }) },
                    { path: '*', lazy: async () => ({ Component: (await import('./PlatformNotFound')).PlatformNotFound }) },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  ],
}
