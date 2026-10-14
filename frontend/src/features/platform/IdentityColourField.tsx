import { Check, RotateCcw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../components/ui/Button'
import { Field } from '../../components/ui/Field'
import { Input } from '../../components/ui/Input'
import { useStableId } from '../../hooks/useStableId'
import { contrast, normaliseHexColour, WHITE } from '../../identity/colour'
import { cn } from '../../utils/cn'

export interface IdentityColourFieldProps {
  /** The field's text: what was typed, or the saved colour. */
  value: string
  onChange: (value: string) => void
  /** The logo's colours, most used first; none without a logo. */
  suggested: readonly string[]
  /** The colour a company without one shows in the picker: the product's default. */
  fallback: string
  error?: string
  /** There is a colour to go back from: a saved one, or one typed. */
  canReset: boolean
  onReset: () => void
  disabled?: boolean
  inputId: string
}

/**
 * A company's colour (Phase 12): the colours found in its logo as one-tap choices, the colour as
 * hex text, and the browser's own colour picker beside it; the three show the same colour. Only the
 * colour is chosen here: the shades the app draws with are derived from it by the server (the
 * preview shows them), so any colour stays readable.
 */
export function IdentityColourField({ value, onChange, suggested, fallback, error, canReset, onReset, disabled = false, inputId }: IdentityColourFieldProps) {
  const { t } = useTranslation('platform')
  const groupId = useStableId('identity-colours')
  const current = normaliseHexColour(value)

  return (
    <div className="flex flex-col gap-5">
      {suggested.length > 0 && (
        <div role="group" aria-labelledby={groupId}>
          <p id={groupId} className="text-sm font-semibold text-fg">
            {t('identity.colour.suggested')}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {suggested.map((colour) => {
              const chosen = current === colour
              return (
                <button
                  key={colour}
                  type="button"
                  aria-pressed={chosen}
                  disabled={disabled}
                  data-suggested-colour={colour}
                  onClick={() => onChange(colour)}
                  className={cn(
                    'inline-flex min-h-11 items-center gap-2 rounded-control border bg-surface py-1.5 ps-1.5 pe-3 text-sm font-medium text-fg transition-colors hover:bg-surface-muted',
                    chosen ? 'border-fg' : 'border-border-strong',
                  )}
                >
                  {/* The swatch is the colour itself; its check mark takes whichever of white and ink reads on it. */}
                  <span
                    aria-hidden="true"
                    className={cn('flex size-8 items-center justify-center rounded-[0.5rem] border border-border', contrast(WHITE, colour) >= 3 ? 'text-white' : 'text-ink-900')}
                    style={{ backgroundColor: colour }}
                  >
                    {chosen && <Check className="size-4" />}
                  </span>
                  <span dir="ltr" className="font-mono text-[0.8125rem]">
                    {colour}
                  </span>
                </button>
              )
            })}
          </div>
        </div>
      )}
      <Field label={t('identity.colour.field')} error={error} id={inputId} className="max-w-xs">
        <div className="flex items-center gap-2">
          <input
            type="color"
            aria-label={t('identity.colour.picker')}
            value={current ?? fallback}
            disabled={disabled}
            data-colour-picker=""
            onChange={(event) => onChange(event.target.value.toLowerCase())}
            className="size-11 shrink-0 cursor-pointer rounded-control border border-border-strong bg-surface p-1 disabled:cursor-not-allowed"
          />
          <Input
            dir="ltr"
            inputMode="text"
            autoCapitalize="none"
            autoComplete="off"
            spellCheck={false}
            maxLength={9}
            value={value}
            disabled={disabled}
            placeholder={fallback}
            onChange={(event) => onChange(event.target.value)}
            className="font-mono"
          />
        </div>
      </Field>
      <div>
        <Button variant="ghost" size="sm" icon={<RotateCcw aria-hidden="true" />} disabled={!canReset || disabled} focusableWhenDisabled onClick={onReset}>
          {t('identity.colour.reset')}
        </Button>
      </div>
    </div>
  )
}
