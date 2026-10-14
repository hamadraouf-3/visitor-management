import { Check } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useStableId } from '../../hooks/useStableId'
import type { VisitStatus } from '../../types/api'
import { cn } from '../../utils/cn'
import { VISIT_STATUS_META } from './statusMeta'

export interface StatusFilterProps {
  /** Offered statuses, in display order. */
  statuses: readonly VisitStatus[]
  /** Selected statuses; empty means every status. */
  value: readonly VisitStatus[]
  onChange: (value: VisitStatus[]) => void
  className?: string
}

/**
 * Multi-select of visit statuses as a row of toggle chips: native checkboxes in a fieldset
 * (Space toggles, Tab moves between them), each chip with the status icon and text, and a
 * check mark when selected, so the state never depends on color (§10). Nothing selected
 * means every status (the list shows them all; no note says so, decision 3 of the brand pass).
 */
export function StatusFilter({ statuses, value, onChange, className }: StatusFilterProps) {
  const { t } = useTranslation()
  const groupId = useStableId('status-filter')
  const toggle = (status: VisitStatus, checked: boolean) => {
    const next = new Set(value)
    if (checked) next.add(status)
    else next.delete(status)
    onChange(statuses.filter((candidate) => next.has(candidate)))
  }

  return (
    <fieldset className={cn('min-w-0', className)}>
      <legend className="mb-1.5 text-sm font-semibold text-fg">{t('filters.status')}</legend>
      <div className="flex flex-wrap gap-2">
        {statuses.map((status) => {
          const meta = VISIT_STATUS_META[status]
          const Icon = meta.icon
          const checked = value.includes(status)
          const inputId = `${groupId}-${status}`
          return (
            <label
              key={status}
              htmlFor={inputId}
              className={cn(
                'inline-flex min-h-9 cursor-pointer items-center gap-1.5 rounded-full border px-3.5 text-sm font-medium select-none pointer-coarse:min-h-11',
                checked
                  ? 'border-accent-strong bg-accent-surface font-semibold text-accent-text'
                  : 'border-border-strong bg-surface text-fg hover:bg-surface-muted',
                // The checkbox itself is visually hidden, so its focus ring is drawn on the chip.
                'has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-focus',
              )}
            >
              <input
                id={inputId}
                type="checkbox"
                className="sr-only"
                checked={checked}
                onChange={(event) => toggle(status, event.target.checked)}
              />
              {checked ? (
                <Check aria-hidden="true" className="size-4 shrink-0" />
              ) : (
                <Icon aria-hidden="true" className={cn('size-4 shrink-0', meta.mirrorIcon && 'mirror-rtl')} />
              )}
              {meta.label}
            </label>
          )
        })}
      </div>
    </fieldset>
  )
}
