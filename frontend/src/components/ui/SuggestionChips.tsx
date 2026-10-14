import { Check, PencilLine } from 'lucide-react'
import type { Ref } from 'react'
import { useStableId } from '../../hooks/useStableId'
import { cn } from '../../utils/cn'

export interface SuggestionChipsProps {
  /** Names the group, e.g. "Common reasons". */
  label: string
  /** Texts a tap puts into the field. */
  suggestions: readonly string[]
  /** The field's current text: the chip whose text it is shows as pressed. */
  value: string
  onPick: (text: string) => void
  /** A last chip that leaves the field to the user (e.g. "Other"), typically focusing it. */
  other?: { label: string; onSelect: () => void }
  /** The first chip, e.g. to receive a dialog's initial focus. */
  firstChipRef?: Ref<HTMLButtonElement>
  className?: string
}

const CHIP =
  'inline-flex min-h-10 items-center gap-1.5 rounded-full border px-3.5 text-start text-sm font-medium select-none pointer-coarse:min-h-11'

/**
 * Quick picks for a free-text field: a tap fills the field with a common answer, which stays
 * editable, so nobody has to type the usual cases on an on-screen keyboard and the stored
 * texts stay consistent. Toggle buttons: the one matching the field's text is pressed (with a
 * check mark, never colour alone).
 */
export function SuggestionChips({ label, suggestions, value, onPick, other, firstChipRef, className }: SuggestionChipsProps) {
  const labelId = useStableId('suggestions')
  const current = value.trim()
  return (
    <div role="group" aria-labelledby={labelId} className={cn('min-w-0', className)}>
      <p id={labelId} className="mb-1.5 text-sm font-semibold text-fg">
        {label}
      </p>
      <div className="flex flex-wrap gap-2">
        {suggestions.map((text, index) => {
          const pressed = current === text
          return (
            <button
              key={text}
              ref={index === 0 ? firstChipRef : undefined}
              type="button"
              aria-pressed={pressed}
              onClick={() => onPick(text)}
              className={cn(
                CHIP,
                pressed ? 'border-accent-strong bg-accent-surface text-accent-text' : 'border-border-strong bg-surface text-fg hover:bg-surface-muted',
              )}
            >
              {pressed && <Check aria-hidden="true" className="size-4 shrink-0" />}
              {text}
            </button>
          )
        })}
        {other && (
          <button type="button" onClick={other.onSelect} className={cn(CHIP, 'border-border-strong bg-surface text-fg hover:bg-surface-muted')}>
            <PencilLine aria-hidden="true" className="size-4 shrink-0" />
            {other.label}
          </button>
        )}
      </div>
    </div>
  )
}
