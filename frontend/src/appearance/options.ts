import { Monitor, Moon, Sun, type LucideIcon } from 'lucide-react'
import type { Appearance } from './appearance'

/** The three choices of appearance, in the order they are offered, each with its symbol. */
export const APPEARANCE_OPTIONS: readonly { value: Appearance; icon: LucideIcon }[] = [
  { value: 'light', icon: Sun },
  { value: 'dark', icon: Moon },
  { value: 'system', icon: Monitor },
]
