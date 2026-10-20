import { useSyncExternalStore } from 'react'
import { currentScheme, DEFAULT_APPEARANCE, readAppearance, subscribeAppearance, type Appearance, type ColorScheme } from './appearance'

/** The device's choice of appearance (Phase 13), live: Light or Dark once chosen, else System. */
export function useAppearance(): Appearance {
  return useSyncExternalStore(subscribeAppearance, readAppearance, () => DEFAULT_APPEARANCE)
}

/**
 * The colour scheme the page is drawn in, live: what is chosen by it in script (a logo's file, the
 * browser chrome's colour, a preview, the appearance toggle's state) follows the device's choice, as
 * the stylesheet does.
 */
export function useColorScheme(): ColorScheme {
  return useSyncExternalStore(subscribeAppearance, currentScheme, () => 'light')
}
