import { cn } from '../../utils/cn'
import { initials } from '../../utils/text'

export interface AvatarProps {
  /** The person's full name: the avatar shows its initials («ليلى الحسن» → «لح», "Omar Khalil" → "OK"). */
  name: string
  /** `sm` 32 px (compact rows), `md` 38 px (direction C's table and list rows, the user block), `lg` 44 px. */
  size?: 'sm' | 'md' | 'lg'
  /**
   * `neutral` (default): a grey tile, for people in lists and tables. `highlight`: mawdoo3's light
   * turquoise with ink text (7.90:1), the signed-in user. `emphasis`: the dark tile with turquoise
   * initials, for the row a screen is about (a visitor inside the building now).
   */
  tone?: 'neutral' | 'highlight' | 'emphasis'
  className?: string
}

const SIZES = {
  sm: 'size-8 rounded-item text-xs',
  md: 'size-[2.375rem] rounded-[0.6875rem] text-[0.8125rem]',
  lg: 'size-11 rounded-control text-sm',
} as const

const TONES = {
  neutral: 'bg-surface-muted text-fg-secondary',
  highlight: 'bg-highlight text-on-highlight',
  // Turquoise on ink 7.90:1, on the deep teal of the dark scheme 6.26:1.
  emphasis: 'bg-emphasis text-highlight',
} as const

/**
 * A person's initials on a tile (direction C). Decorative: the person's name is always written
 * next to it, so assistive technology does not read the initials as well.
 */
export function Avatar({ name, size = 'md', tone = 'neutral', className }: AvatarProps) {
  return (
    <span
      aria-hidden="true"
      data-avatar=""
      className={cn('flex shrink-0 items-center justify-center font-semibold select-none', SIZES[size], TONES[tone], className)}
    >
      {initials(name)}
    </span>
  )
}
