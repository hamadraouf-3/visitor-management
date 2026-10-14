import { ListFilter } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useStableId } from '../../hooks/useStableId'
import { cn } from '../../utils/cn'
import { Button } from './Button'

export interface FilterPanelProps {
  /** How many filters narrow the list; shown on the phone toggle ("Filters (2)"). */
  activeCount: number
  children: ReactNode
}

/**
 * The filters of a list page, in one panel above the list. On phones the panel is collapsed
 * behind a "Filters" button (a disclosure), so the list starts on the first screen; from `sm`
 * up it is always open.
 */
export function FilterPanel({ activeCount, children }: FilterPanelProps) {
  const { t } = useTranslation()
  const panelId = useStableId('filters')
  const [open, setOpen] = useState(false)
  return (
    <section aria-label={t('filters.label')} className="mb-4 rounded-card border border-border bg-surface p-4 print:hidden">
      <div className="sm:hidden">
        <Button
          variant="secondary"
          icon={<ListFilter aria-hidden="true" />}
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((current) => !current)}
        >
          {activeCount > 0 ? t('filters.toggleWithCount', { count: activeCount }) : t('filters.toggle')}
        </Button>
      </div>
      <div id={panelId} className={cn('flex flex-col gap-4', !open && 'max-sm:hidden', 'max-sm:mt-4')}>
        {children}
      </div>
    </section>
  )
}
