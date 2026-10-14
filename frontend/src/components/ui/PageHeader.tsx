import { ChevronLeft } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { useDocumentTitle } from '../../hooks/useDocumentTitle'
import { cn } from '../../utils/cn'

export interface PageHeaderProps {
  title: string
  /** A small line above the title, e.g. the section ("Administration · Dashboard"), as in direction C. */
  eyebrow?: ReactNode
  /** Before the title, on its row: what the page is about as a picture (a company's logo). Decorative. */
  leading?: ReactNode
  /**
   * Whose page this is, right above the title and beside `leading`: the company a platform page
   * about one of its parts belongs to ("Sahara Sun Hotels" above "Identity"). A name, as data.
   */
  subject?: ReactNode
  /**
   * A line of facts under the title (direction C: "Wed 7 Oct 2026 · Updated 11:20"): data only,
   * usually a `MetaLine`.
   */
  meta?: ReactNode
  /** Primary page actions. */
  actions?: ReactNode
  /**
   * What phones (below `sm`) show instead of `actions`: one compact control beside the title,
   * e.g. a link or a menu that gathers the actions, so the page does not open with a stack of
   * full-width buttons before its content. Without it, phones show `actions` full width.
   */
  mobileActions?: ReactNode
  /**
   * Keep `actions` beside the title at every width, also on phones (one compact control, e.g.
   * a search button on a screen whose content must start near the top), instead of a
   * full-width row under the title. `mobileActions` is then not needed.
   */
  actionsBesideTitle?: boolean
  /** A smaller gap below the header, for a screen whose content must start near the top (reception). */
  compact?: boolean
  /** "Back to …" link above the title; `state` restores the view there (see `useBackLink`). */
  back?: { to: string; label: string; state?: unknown }
  /** Overrides the document title (defaults to `title`). */
  documentTitle?: string
  className?: string
}

/**
 * Page title (the page's only h1, 34 px bold in direction C, 26 px on phones) plus actions; also
 * sets the document title.
 */
export function PageHeader({
  title,
  eyebrow,
  leading,
  subject,
  meta,
  actions,
  mobileActions,
  actionsBesideTitle = false,
  compact = false,
  back,
  documentTitle,
  className,
}: PageHeaderProps) {
  useDocumentTitle(documentTitle ?? title)
  return (
    <header className={cn(compact ? 'mb-4' : 'mb-6', 'flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between', className)}>
      <div className="min-w-0 flex-1">
        {back && (
          <Link
            to={back.to}
            state={back.state}
            className="mb-2 inline-flex min-h-6 items-center gap-1 rounded-sm text-sm font-semibold text-accent-text hover:underline pointer-coarse:min-h-11 print:hidden"
          >
            {/* "Back" points against the reading direction: left in English, right in Arabic. */}
            <ChevronLeft aria-hidden="true" className="mirror-rtl size-4" />
            {back.label}
          </Link>
        )}
        {eyebrow && <p className="mb-1 text-[0.8125rem] font-medium text-fg-muted">{eyebrow}</p>}
        <div className="flex items-start justify-between gap-3">
          <div className={cn('min-w-0', leading !== undefined && 'flex items-center gap-3 sm:gap-4')}>
            {leading}
            <div className="min-w-0">
              {subject && (
                <p data-page-subject="" dir="auto" className="text-sm font-semibold break-words text-fg-secondary sm:text-base">
                  {subject}
                </p>
              )}
              {/* tabIndex -1: the layout moves focus here after client-side navigation. */}
              <h1 tabIndex={-1} className="min-w-0 text-page-sm font-bold break-words text-fg focus:outline-none sm:text-page">
                {title}
              </h1>
            </div>
          </div>
          {mobileActions && !actionsBesideTitle && <div className="shrink-0 sm:hidden print:hidden">{mobileActions}</div>}
          {actions && actionsBesideTitle && <div className="flex shrink-0 flex-wrap justify-end gap-2 print:hidden">{actions}</div>}
        </div>
        {meta && <div className="mt-2">{meta}</div>}
      </div>
      {/* Phones without `mobileActions`: one full-width action per row, in the order given (primary first). */}
      {actions && !actionsBesideTitle && (
        <div className={cn('shrink-0 gap-2 sm:flex sm:flex-wrap sm:justify-end print:hidden', mobileActions ? 'max-sm:hidden' : 'grid grid-cols-1')}>
          {actions}
        </div>
      )}
    </header>
  )
}
