import { Moon, Sun } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { SWITCH_BUTTON } from '../components/ui/buttonStyles'
import { cn } from '../utils/cn'
import { chooseAppearance } from './appearance'
import { useColorScheme } from './useAppearance'

export interface AppearanceToggleProps {
  /**
   * The screen is dark by design (the reception, `useShellSurface`): what is shown there is dark
   * also while the page's own scheme is light, so a press asks for the light one.
   */
  darkSurface?: boolean
  className?: string
}

/**
 * The appearance (Phase 13, F13-25): one toggle button beside the language switch, the same size
 * and look, on the signed-out pages, the pass and both shells. Until it is pressed the page follows
 * the device; a press draws the other scheme than the one shown and keeps that choice (`light` or
 * `dark`) on the device. Named «الوضع الداكن» / "Dark mode", pressed (`aria-pressed`) while dark.
 * Its symbol is the scheme a press leads to, as the language switch beside it names the other
 * language: the moon while light, the sun while dark. No words on screen: the name is read, and
 * shown as the button's tooltip.
 */
export function AppearanceToggle({ darkSurface = false, className }: AppearanceToggleProps) {
  const { t } = useTranslation()
  const scheme = useColorScheme()
  const dark = darkSurface || scheme === 'dark'
  const Icon = dark ? Sun : Moon
  const name = t('appearance.darkMode')

  return (
    <button
      type="button"
      aria-pressed={dark}
      title={name}
      onClick={() => chooseAppearance(dark ? 'light' : 'dark')}
      data-appearance-toggle=""
      className={cn(SWITCH_BUTTON, className)}
    >
      <Icon aria-hidden="true" className="size-[1.125rem] shrink-0" />
      <span className="sr-only">{name}</span>
    </button>
  )
}
