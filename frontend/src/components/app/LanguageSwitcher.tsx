import { LANGUAGE_NAMES, type Language } from '../../i18n'
import { useChangeLanguage, useLanguage } from '../../i18n/useLanguage'
import { cn } from '../../utils/cn'
import { SWITCH_BUTTON } from '../ui/buttonStyles'

export interface LanguageSwitchButtonProps {
  /** Switches to `language` (the other one). */
  onSwitch: (language: Language) => void
  /** A switch is being saved: the button ignores activation and says it is busy. */
  pending?: boolean
  className?: string
}

/**
 * The language switch (ع / EN): one button that offers the other language, under that language's
 * own name and in its own script (`lang`), so whoever needs it can read it. Its accessible name
 * ("English", "العربية") contains the visible label ("EN", "ع"; WCAG 2.5.3). Where the choice is
 * saved is the caller's: `LanguageSwitcher` (the company session) or the platform owner's switch.
 */
export function LanguageSwitchButton({ onSwitch, pending = false, className }: LanguageSwitchButtonProps) {
  const { language } = useLanguage()
  const target: Language = language === 'ar' ? 'en' : 'ar'
  const names = LANGUAGE_NAMES[target]

  return (
    <button
      type="button"
      lang={target}
      title={names.name}
      aria-disabled={pending || undefined}
      onClick={() => {
        if (!pending) onSwitch(target)
      }}
      data-language-switch=""
      className={cn(SWITCH_BUTTON, 'font-numeric text-sm font-semibold aria-disabled:cursor-progress', className)}
    >
      <span aria-hidden="true">{names.short}</span>
      <span className="sr-only">{names.name}</span>
    </button>
  )
}

/**
 * The company session's language switch. Signed in, the choice is saved to the account (PATCH
 * /auth/preferences); signed out it is remembered on the device. The screen switches at once;
 * focus stays on the button.
 */
export function LanguageSwitcher({ className }: { className?: string }) {
  const change = useChangeLanguage()
  return <LanguageSwitchButton onSwitch={(language) => change.mutate(language)} pending={change.isPending} className={className} />
}
