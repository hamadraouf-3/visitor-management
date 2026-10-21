import { useTranslation } from 'react-i18next'
import { NavLink } from 'react-router'
import type { NavEntry, NavSection } from '../features/types'
import { paths } from '../paths'
import { cn } from '../utils/cn'

type SectionHeadingKey = 'nav.sections.insights' | 'nav.sections.admin'

const SECTIONS: readonly { id: NavSection; heading: SectionHeadingKey | null }[] = [
  { id: 'main', heading: null },
  { id: 'insights', heading: 'nav.sections.insights' },
  { id: 'admin', heading: 'nav.sections.admin' },
]

type NavItemKey =
  | 'nav.items.reception'
  | 'nav.items.myVisits'
  | 'nav.items.inviteVisitor'
  | 'nav.items.visitors'
  | 'nav.items.inside'
  | 'nav.items.journey'
  | 'nav.items.history'
  | 'nav.items.reports'
  | 'nav.items.adminDashboard'
  | 'nav.items.adminUsers'
  | 'nav.items.adminDepartments'
  | 'nav.items.adminSettings'
  | 'nav.items.adminAudit'
  | 'nav.items.adminEmailTemplates'
  | 'nav.items.adminTracking'
  | 'nav.items.platformCompanies'
  | 'nav.items.platformAudit'

/**
 * The shell names each section in the UI language, by its path: features declare their entries
 * (`routes.tsx`) with an English `label`, which stays the fallback for a path not listed here.
 */
const NAV_LABEL_KEYS: Readonly<Record<string, NavItemKey>> = {
  [paths.reception]: 'nav.items.reception',
  [paths.myVisits]: 'nav.items.myVisits',
  [paths.inviteVisitor]: 'nav.items.inviteVisitor',
  [paths.visitors]: 'nav.items.visitors',
  [paths.inside]: 'nav.items.inside',
  [paths.journey]: 'nav.items.journey',
  [paths.history]: 'nav.items.history',
  [paths.reports]: 'nav.items.reports',
  [paths.adminDashboard]: 'nav.items.adminDashboard',
  [paths.adminUsers]: 'nav.items.adminUsers',
  [paths.adminDepartments]: 'nav.items.adminDepartments',
  [paths.adminSettings]: 'nav.items.adminSettings',
  [paths.adminAudit]: 'nav.items.adminAudit',
  [paths.adminEmailTemplates]: 'nav.items.adminEmailTemplates',
  [paths.adminTracking]: 'nav.items.adminTracking',
  [paths.platformCompanies]: 'nav.items.platformCompanies',
  [paths.platformAudit]: 'nav.items.platformAudit',
}

interface NavigationProps {
  entries: readonly NavEntry[]
  /** Called after a link is activated (closes the mobile drawer). */
  onNavigate?: () => void
}

/**
 * Role-filtered navigation, grouped into sections, on the shell (direction C in mawdoo3's colours,
 * or a company's own): the current page (`aria-current="page"`) is a pill in the shell's ink with
 * the shell's colour as its text and a bolder label (white with teal text on the teal shell, the
 * dark ink with yellow text on a yellow company's), a turquoise pill with ink text on the deep
 * shell. Hover lays a step of the ink's direction over the item. Every colour is a token of the
 * shell's set (`index.css`, `identity/tokens.ts`): nothing here names one.
 */
export function Navigation({ entries, onNavigate }: NavigationProps) {
  const { t } = useTranslation()
  const sorted = entries.toSorted((a, b) => a.order - b.order)
  const groups = SECTIONS.map((section) => ({ ...section, entries: sorted.filter((entry) => entry.section === section.id) })).filter(
    (group) => group.entries.length > 0,
  )

  return (
    <nav aria-label={t('nav.label')} className="flex flex-col gap-5 px-3 py-4">
      {groups.map((group) => (
        <div key={group.id}>
          {group.heading && <h2 className="mb-1.5 px-3 text-xs font-semibold tracking-wide text-fg-muted">{t(group.heading)}</h2>}
          <ul className="flex flex-col gap-0.5">
            {group.entries.map((entry) => {
              const Icon = entry.icon
              const labelKey = NAV_LABEL_KEYS[entry.to]
              return (
                <li key={entry.to}>
                  <NavLink
                    to={entry.to}
                    end={entry.end}
                    onClick={onNavigate}
                    className={({ isActive }) =>
                      cn(
                        'flex min-h-11 items-center gap-3 rounded-item px-3 py-2 text-[0.90625rem] transition-colors',
                        isActive
                          ? // The pill against the shell 4.70:1 (white on teal), 4.90:1 (turquoise on the deep
                            // shell), at least 4.5:1 on a company's (its ink on its surface); its label 6.33:1 /
                            // 7.31:1; the focus ring is drawn on the shell around it, in the shell's ink.
                            'bg-accent font-semibold text-on-accent shadow-raise'
                          : 'font-medium text-fg-secondary hover:bg-surface-muted hover:text-fg',
                      )
                    }
                  >
                    <Icon aria-hidden="true" className="size-5 shrink-0" />
                    {labelKey ? t(labelKey) : entry.label}
                  </NavLink>
                </li>
              )
            })}
          </ul>
        </div>
      ))}
    </nav>
  )
}
