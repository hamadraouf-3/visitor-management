import { Headset, ShieldCheck, UserRound, UsersRound, type LucideIcon } from 'lucide-react'
import type { Tone } from '../../components/ui/tones'
import type { Role } from '../../types/api'

/**
 * Each role's icon and tile tone, the same wherever a role is shown as a row or an option (the
 * dashboard's accounts card, the role choices of the user dialogs). Decorative: the role's name is
 * always written beside it.
 */
export const ROLE_VISUALS: Readonly<Record<Role, { icon: LucideIcon; tone: Tone }>> = {
  EMPLOYEE: { icon: UserRound, tone: 'info' },
  RECEPTIONIST: { icon: Headset, tone: 'success' },
  MANAGEMENT: { icon: UsersRound, tone: 'neutral' },
  SYSTEM_ADMIN: { icon: ShieldCheck, tone: 'accent' },
}
