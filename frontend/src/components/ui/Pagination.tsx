import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatCount } from '../../utils/number'
import { cn } from '../../utils/cn'
import { Button } from './Button'

export interface PaginationProps {
  page: number
  pageSize: number
  total: number
  onPageChange: (page: number) => void
  /** Accessible name of the navigation landmark. */
  label?: string
  className?: string
}

/**
 * The range shown ("Showing 1–25 of 60") and, when there is more than one page, Previous/next
 * paging. The buttons stay focusable at the first and last page (`focusableWhenDisabled`):
 * pressing Next onto the last page leaves focus on Next, now announced as unavailable,
 * instead of dropping it to the top of the document.
 */
export function Pagination({ page, pageSize, total, onPageChange, label, className }: PaginationProps) {
  const { t } = useTranslation()
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  const current = Math.min(Math.max(1, page), pageCount)
  const from = total === 0 ? 0 : (current - 1) * pageSize + 1
  const to = Math.min(total, current * pageSize)
  const summary = (
    <p className="text-sm text-fg-muted">
      {total === 0 ? t('pagination.noResults') : t('pagination.showing', { from, to, total: formatCount(total) })}
    </p>
  )

  if (pageCount === 1) {
    return <div className={cn('py-3', className)}>{summary}</div>
  }

  return (
    <nav aria-label={label ?? t('pagination.label')} className={cn('flex flex-wrap items-center justify-between gap-3 py-3', className)}>
      {summary}
      <div className="flex items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          icon={<ChevronLeft aria-hidden="true" className="mirror-rtl" />}
          onClick={() => onPageChange(current - 1)}
          disabled={current <= 1}
          focusableWhenDisabled
        >
          {t('actions.previous')}
        </Button>
        <span className="px-1 text-sm text-fg-muted tabular-nums">{t('pagination.page', { page: current, pageCount })}</span>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => onPageChange(current + 1)}
          disabled={current >= pageCount}
          focusableWhenDisabled
        >
          {t('actions.next')}
          <ChevronRight aria-hidden="true" className="mirror-rtl" />
        </Button>
      </div>
    </nav>
  )
}
