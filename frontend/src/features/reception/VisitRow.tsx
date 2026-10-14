import { Ellipsis } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Avatar } from '../../components/ui/Avatar'
import { buttonClassName } from '../../components/ui/buttonStyles'
import { DataLine } from '../../components/ui/DataLine'
import { Menu, type MenuItem } from '../../components/ui/Menu'
import { PhoneLink } from '../../components/ui/PhoneLink'
import { FOCUS_ROW_ATTRIBUTE } from '../../hooks/useListFocusRecovery'
import { useDepartmentName } from '../../i18n/departmentName'
import { withParts } from '../../i18n/withParts'
import type { Visit } from '../../types/api'
import { cn } from '../../utils/cn'

export interface VisitRowProps {
  visit: Visit
  /** When: e.g. the scheduled time, or the check-in time. */
  when: ReactNode
  /** `when` is a bare time ("09:00–10:00"): Space Grotesk, direction C's numerals. */
  whenNumeric?: boolean
  /** Status badges beside the name. */
  badges?: ReactNode
  /** The row's one visible action (a touch-sized button marked `data-row-action`). */
  action?: ReactNode
  /** Rarer actions, in a "More actions" menu beside the visible one. */
  moreActions?: readonly MenuItem[]
  /**
   * Show the visitor's initials, name and company (default). Off where the visitor is already
   * named above the row (a visitor's visits in "Find a visitor"): the first line then holds the
   * badges.
   */
  showVisitor?: boolean
  /** The visitor is inside the building: the initials tile turns to the dark one with turquoise letters. */
  inside?: boolean
}

/**
 * One visit in a reception list (Expected, Inside, Find a visitor), direction C's list row: the
 * visitor's initials, then two lines: the visitor, company and status first; then the time, host
 * with a tap-to-call phone, department and purpose (cut to the line). Rows sit in a `VisitList`
 * (one framed card, hairlines between rows). The action sits at the end from `sm`, below the
 * details on phones, so a list reads as visitors, not as a wall of buttons. Rarer actions wait in
 * the row's menu: beside the action from `sm`, in the row's top corner on phones, so a row with
 * nothing but a menu ends at its last line of details instead of a line of its own.
 */
export function VisitRow({ visit, when, whenNumeric = false, badges, action, moreActions = [], showVisitor = true, inside = false }: VisitRowProps) {
  const { t } = useTranslation('reception')
  const departmentName = useDepartmentName()
  const name = visit.visitor.full_name
  const hasMenu = moreActions.length > 0
  return (
    <li
      {...{ [FOCUS_ROW_ATTRIBUTE]: visit.id }}
      className="relative flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:gap-4 sm:px-5"
    >
      {/* On phones the details leave room for the menu in the corner. */}
      <div className={cn('flex min-w-0 flex-1 items-start gap-3 sm:items-center', hasMenu && 'max-sm:pe-11')}>
        {showVisitor && <Avatar name={name} tone={inside ? 'emphasis' : 'neutral'} />}
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {showVisitor && (
              <>
                <span className="text-base leading-snug font-semibold break-words text-fg">{name}</span>
                {visit.visitor.company_name && <span className="text-meta break-words text-fg-muted">{visit.visitor.company_name}</span>}
              </>
            )}
            {badges}
          </p>
          {/* Separate items rather than one "·"-joined text, so a wrap never leaves a dangling separator. */}
          <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-meta text-fg-muted">
            <span className={cn('font-medium text-fg tabular-nums', whenNumeric && 'font-numeric')}>{when}</span>
            {/* Host and department each isolated: an Arabic name beside an Arabic department in the English UI
                must not merge into one right-to-left run ("Host العمليات · عمر خليل"). */}
            <span className="break-words">
              <DataLine
                items={[withParts((markers) => t('hostNamed', { name: markers.name }), { name: <bdi>{visit.host.full_name}</bdi> }), departmentName(visit.department)]}
              />
            </span>
            {visit.host.phone && <PhoneLink phone={visit.host.phone} label={t('call', { name: visit.host.full_name })} />}
            {/* In its own direction (an English purpose in the Arabic list is cut at its end, "Product demo for…",
                not at its start), aligned as the line is (match-parent; Chromium knows the prefixed form). */}
            <span dir="auto" title={visit.purpose} className="max-w-full truncate [text-align:-webkit-match-parent] [text-align:match-parent]">
              {visit.purpose}
            </span>
          </p>
        </div>
      </div>
      {(action || hasMenu) && (
        // Without an action the group adds no line on phones: only its menu, in the corner.
        <div className={cn('flex shrink-0 items-center justify-end gap-2', !action && 'max-sm:contents')}>
          {/* On phones the action is the row's full width and its label may wrap (centred, the icon kept
              whole): «التحقق من الهوية وتسجيل الدخول» is wider than a 360 px card (WCAG 1.4.10). */}
          {action && (
            <div className="max-sm:min-w-0 max-sm:flex-1 max-sm:[&>*]:w-full max-sm:[&>*]:text-center max-sm:[&>*]:text-balance max-sm:[&>*]:py-2 max-sm:[&>*]:whitespace-normal max-sm:[&>*_svg]:shrink-0">
              {action}
            </div>
          )}
          {hasMenu && (
            <div data-row-menu="" className="max-sm:absolute max-sm:end-2 max-sm:top-2">
              <Menu
                trigger={<Ellipsis aria-hidden="true" />}
                triggerLabel={t('moreActionsFor', { name })}
                triggerClassName={buttonClassName({ variant: 'ghost', size: 'lg', className: 'px-3' })}
                items={moreActions}
              />
            </div>
          )}
        </div>
      )}
    </li>
  )
}

/**
 * The rows of a reception list in one framed card with hairlines between them (direction C's
 * list). `label` names it where no heading right above it does.
 */
export function VisitList({ label, children, className }: { label?: string; children: ReactNode; className?: string }) {
  return (
    <ul aria-label={label} className={cn('divide-y divide-border-subtle rounded-card border border-border bg-surface', className)}>
      {children}
    </ul>
  )
}
