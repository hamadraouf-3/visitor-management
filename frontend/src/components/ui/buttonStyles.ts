import { cn } from '../../utils/cn'

/**
 * `danger` (solid) confirms a destructive action inside its confirmation dialog;
 * `danger-outline` offers it on a page, where it must not outweigh the everyday actions.
 * Every primary action is the teal `primary` (one style across the app); on the dark surfaces
 * (`theme-dark`) it is mawdoo3's turquoise with ink text (7.31:1), direction C's bright accent.
 * A company's primary button is its own colour under its ink (Phase 12: a yellow company's is
 * yellow with dark text).
 */
export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'danger-outline' | 'ghost'
/**
 * `md` is 44 px tall, direction C's control height and the comfortable tap target. `sm` (36 px)
 * grows to 44 px on touch screens (coarse pointer). `xl` is the touch size for reception tablets.
 */
export type ButtonSize = 'sm' | 'md' | 'lg' | 'xl'

/**
 * The edge of an accent fill (a primary button, a chosen segment), drawn inside it so nothing moves:
 * `accent-edge` is no colour unless the fill would blend into the card it lies on (a white or
 * near-white company's colour), where it is the fill's ink.
 */
export const ACCENT_FILL_EDGE = 'inset-ring-[1.5px] inset-ring-accent-edge'

/**
 * The chosen one of a set whose choice is shown by its fill alone (the appearance's segments, a
 * menu's choice tiles; the kit's segmented `RadioGroup` adds a check mark instead). A forced-colours
 * mode (Windows' contrast themes) draws every fill as the page's own `Canvas`, so there the chosen
 * one takes the system's selection colours, `Highlight` under `HighlightText`, kept as they are
 * (`forced-color-adjust: none`: else the backplate the browser draws behind text hides the text),
 * with its focus ring in the system's text colour (on the element, or for a hidden radio inside it).
 */
export const FORCED_COLORS_CHOSEN =
  'forced-colors:forced-color-adjust-none forced-colors:border-[color:Highlight] forced-colors:bg-[color:Highlight] forced-colors:text-[color:HighlightText] ' +
  'forced-colors:outline-[color:CanvasText] forced-colors:has-focus-visible:outline-[color:CanvasText]'

const base =
  'inline-flex items-center justify-center gap-2 rounded-control font-semibold whitespace-nowrap select-none ' +
  'transition-colors disabled:cursor-not-allowed disabled:opacity-60 ' +
  'aria-disabled:cursor-not-allowed aria-disabled:opacity-60'

// Unavailable buttons are either natively `disabled` or focusable with `aria-disabled` (see
// Button); both look the same and keep their resting background on hover.
const variantClasses: Record<ButtonVariant, string> = {
  // mawdoo3's side-nav teal #188086 with white text (4.70:1); its turquoise would be 2.50:1. The
  // ring inside it is no colour, except for a company whose colour would blend into a white card.
  primary: `bg-accent text-on-accent hover:bg-accent-hover disabled:hover:bg-accent aria-disabled:hover:bg-accent ${ACCENT_FILL_EDGE}`,
  secondary:
    'border border-border-strong bg-surface text-fg hover:bg-surface-muted disabled:hover:bg-surface aria-disabled:hover:bg-surface',
  danger:
    'bg-danger-solid text-on-danger hover:bg-danger-hover disabled:hover:bg-danger-solid aria-disabled:hover:bg-danger-solid',
  // Border red on white: 5.62:1 (WCAG 1.4.11 needs 3:1); text 6.53:1.
  'danger-outline':
    'border border-danger-solid bg-surface text-danger-text hover:bg-danger-surface disabled:hover:bg-surface aria-disabled:hover:bg-surface',
  ghost: 'bg-transparent text-fg hover:bg-surface-muted disabled:hover:bg-transparent aria-disabled:hover:bg-transparent',
}

const sizeClasses: Record<ButtonSize, string> = {
  sm: 'min-h-9 px-3 text-sm pointer-coarse:min-h-11 [&_svg]:size-4',
  md: 'min-h-11 px-4 text-sm [&_svg]:size-[1.125rem]',
  lg: 'min-h-12 px-5 text-base [&_svg]:size-5',
  xl: 'min-h-14 px-6 text-lg font-bold [&_svg]:size-6',
}

export interface ButtonStyleOptions {
  variant?: ButtonVariant
  size?: ButtonSize
  fullWidth?: boolean
  className?: string
}

export function buttonClassName({ variant = 'primary', size = 'md', fullWidth = false, className }: ButtonStyleOptions = {}) {
  return cn(base, variantClasses[variant], sizeClasses[size], fullWidth && 'w-full', className)
}
