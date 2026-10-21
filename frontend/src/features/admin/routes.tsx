import { Building, LayoutDashboard, Mail, Radar, ScrollText, Settings, Users } from 'lucide-react'
import { RequireRole } from '../../auth/RequireRole'
import { RequireTrackingAllowed } from '../../auth/RequireTrackingAllowed'
import { SECTION_ACCESS } from '../../auth/roles'
import { paths } from '../../paths'
import type { FeatureModule, NavEntry } from '../types'

const adminNav = (entry: Omit<NavEntry, 'roles' | 'section'>): NavEntry => ({
  ...entry,
  roles: SECTION_ACCESS.admin,
  section: 'admin',
})

export const adminFeature: FeatureModule = {
  routes: [
    {
      element: <RequireRole roles={SECTION_ACCESS.admin} />,
      // Lazy pages (separate chunks): the sign-in and pass pages never download them.
      children: [
        { path: 'admin', lazy: async () => ({ Component: (await import('./AdminDashboardPage')).AdminDashboardPage }) },
        { path: 'admin/users', lazy: async () => ({ Component: (await import('./UsersPage')).UsersPage }) },
        { path: 'admin/departments', lazy: async () => ({ Component: (await import('./DepartmentsPage')).DepartmentsPage }) },
        { path: 'admin/settings', lazy: async () => ({ Component: (await import('./CompanySettingsPage')).CompanySettingsPage }) },
        { path: 'admin/audit', lazy: async () => ({ Component: (await import('./AuditLogPage')).AuditLogPage }) },
        { path: 'admin/email-templates', lazy: async () => ({ Component: (await import('./EmailTemplatesPage')).EmailTemplatesPage }) },
        { path: 'admin/email-templates/:kind', lazy: async () => ({ Component: (await import('./EmailTemplatePage')).EmailTemplatePage }) },
        // Phase 15: visitor tracking (the switch, thresholds and keys; the locations; the cameras), only while
        // the platform owner allows the company's tracking.
        {
          element: <RequireTrackingAllowed />,
          children: [{ path: 'admin/tracking', lazy: async () => ({ Component: (await import('./tracking/TrackingAdminPage')).TrackingAdminPage }) }],
        },
      ],
    },
  ],
  nav: [
    adminNav({ to: paths.adminDashboard, label: 'Dashboard', icon: LayoutDashboard, order: 80, end: true }),
    adminNav({ to: paths.adminUsers, label: 'Users', icon: Users, order: 81 }),
    adminNav({ to: paths.adminDepartments, label: 'Departments', icon: Building, order: 82 }),
    adminNav({ to: paths.adminSettings, label: 'Company settings', icon: Settings, order: 83 }),
    adminNav({ to: paths.adminEmailTemplates, label: 'Email texts', icon: Mail, order: 83.5 }),
    adminNav({ to: paths.adminTracking, label: 'Visitor tracking', icon: Radar, order: 83.7, requiresTracking: true }),
    adminNav({ to: paths.adminAudit, label: 'Audit log', icon: ScrollText, order: 84 }),
  ],
}
