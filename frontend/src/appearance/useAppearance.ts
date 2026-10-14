import { useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import type { MenuRadioGroup } from '../components/ui/Menu'
import { chooseAppearance, currentScheme, DEFAULT_APPEARANCE, isAppearance, readAppearance, subscribeAppearance, type Appearance, type ColorScheme } from './appearance'
import { APPEARANCE_OPTIONS } from './options'

/** The device's choice of appearance (Phase 13), live: Light, Dark or System. */
export function useAppearance(): Appearance {
  return useSyncExternalStore(subscribeAppearance, readAppearance, () => DEFAULT_APPEARANCE)
}

/**
 * The colour scheme the page is drawn in, live: what is chosen by it in script (a logo's file, the
 * browser chrome's colour, a preview) follows the device's choice, as the stylesheet does.
 */
export function useColorScheme(): ColorScheme {
  return useSyncExternalStore(subscribeAppearance, currentScheme, () => 'light')
}

/**
 * The appearance as a group of the account menu (the company's and the platform owner's): three
 * `menuitemradio` items named "Appearance", which keep the menu open when one is chosen (`Menu`).
 */
export function useAppearanceMenuGroup(): MenuRadioGroup {
  const { t } = useTranslation()
  const appearance = useAppearance()
  return {
    id: 'appearance',
    type: 'radio-group',
    label: t('appearance.label'),
    value: appearance,
    options: APPEARANCE_OPTIONS.map(({ value, icon }) => ({ value, icon, label: t(`appearance.${value}`) })),
    onValueChange: (value) => {
      if (isAppearance(value)) chooseAppearance(value)
    },
  }
}
