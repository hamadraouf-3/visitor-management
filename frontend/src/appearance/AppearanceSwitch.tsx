import { useTranslation } from 'react-i18next'
import { FORCED_COLORS_CHOSEN } from '../components/ui/buttonStyles'
import { useStableId } from '../hooks/useStableId'
import { cn } from '../utils/cn'
import { chooseAppearance } from './appearance'
import { APPEARANCE_OPTIONS } from './options'
import { useAppearance } from './useAppearance'

/**
 * The appearance switch of the pages before sign-in and of the visitor's pass (Phase 13), beside the
 * language switch: Light, Dark or System, for this device. A radio group of native radios (the arrow
 * keys move and choose, in the reading direction; Tab enters and leaves it), named "Appearance" for
 * assistive technology; on screen three joined segments with the symbol and the word, each a 44 px
 * target. The chosen one is direction C's ink tile (the light ink in the dark scheme): neutral, not
 * the company's colour, which marks actions; in a forced-colours mode (Windows' contrast themes) the
 * system's selection colours, where every fill is the page's own. No words besides the three. It never
 * shrinks below its segments: a header too narrow for it and the language switch wraps instead.
 */
export function AppearanceSwitch({ className }: { className?: string }) {
  const { t } = useTranslation()
  const appearance = useAppearance()
  const id = useStableId('appearance')

  return (
    <fieldset role="radiogroup" aria-labelledby={`${id}-legend`} data-appearance-switch="" className={cn('max-w-full shrink-0', className)}>
      <legend id={`${id}-legend`} className="sr-only">
        {t('appearance.label')}
      </legend>
      {/* One row; only where the three are wider than the whole header (a phone with a large text size) do they wrap, never off the screen. */}
      <div className="flex flex-wrap ps-px">
        {APPEARANCE_OPTIONS.map(({ value, icon: Icon }) => {
          const checked = value === appearance
          return (
            <label
              key={value}
              className={cn(
                'relative inline-flex min-h-11 cursor-pointer items-center gap-1.5 border px-2.5 text-[0.8125rem] font-medium whitespace-nowrap select-none',
                // Joined: each segment's edge lies under its neighbour's (the row's 1 px start room takes the first one's), so a wrapped segment keeps all four.
                '-ms-px first:rounded-s-control last:rounded-e-control',
                checked ? cn('border-ink bg-ink font-semibold text-on-ink', FORCED_COLORS_CHOSEN) : 'border-border-strong bg-surface text-fg hover:bg-surface-muted',
                // The radio itself is visually hidden: its focus ring is drawn on the segment, above its neighbours.
                'has-focus-visible:z-10 has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-focus',
              )}
            >
              <input type="radio" name={id} value={value} checked={checked} onChange={() => chooseAppearance(value)} className="sr-only" />
              <Icon aria-hidden="true" className="size-4 shrink-0" />
              {t(`appearance.${value}`)}
            </label>
          )
        })}
      </div>
    </fieldset>
  )
}
