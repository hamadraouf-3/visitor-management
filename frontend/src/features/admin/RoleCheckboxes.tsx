import { Check, CircleAlert, Lock } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { Role } from '../../types/api'
import { cn } from '../../utils/cn'
import { toneTileClasses } from '../../components/ui/tones'
import { ROLE_VISUALS } from './roleVisuals'
import { orderedRoles, ROLE_OPTIONS } from './userForm'

export interface RoleCheckboxesProps {
  /** Id of the group (the form focuses its first checkbox after a failed submit). */
  id: string
  value: readonly Role[]
  onChange: (roles: Role[]) => void
  error?: string
  /** A role that may not be removed here, with the reason its checkbox is described by. */
  locked?: { role: Role; reason: string } | null
  className?: string
}

/**
 * The roles of an account (roles combine, D-04) as direction C's option tiles: a native checkbox,
 * the role's icon and name in one bordered tile that is the whole tap target; a chosen tile takes
 * the teal edge and tint and a check mark (never colour alone). A locked role stays checked and
 * disabled with a lock on its tile; its reason describes its checkbox for assistive technology
 * and is not a standing sentence under the group (the user's request 8: no explanatory notes).
 */
export function RoleCheckboxes({ id, value, onChange, error, locked, className }: RoleCheckboxesProps) {
  const { t } = useTranslation('admin')
  const errorId = `${id}-error`
  const lockId = `${id}-lock`
  const toggle = (role: Role, checked: boolean) => {
    const next = checked ? [...value, role] : value.filter((candidate) => candidate !== role)
    onChange(orderedRoles(next))
  }
  return (
    <fieldset id={id} aria-describedby={error ? errorId : undefined} aria-invalid={error ? true : undefined} className={cn('min-w-0', className)}>
      <legend className="mb-1.5 text-sm font-semibold text-fg">{t('users.form.roles')}</legend>
      <div className="grid grid-cols-1 gap-2 min-[26rem]:grid-cols-2">
        {ROLE_OPTIONS.map((option) => {
          const isLocked = locked?.role === option.role
          const checked = value.includes(option.role)
          const visual = ROLE_VISUALS[option.role]
          const Icon = visual.icon
          return (
            <label
              key={option.role}
              className={cn(
                'flex min-h-12 items-center gap-3 rounded-control border px-3 py-2 transition-colors',
                'has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-focus',
                checked ? 'border-accent-strong bg-accent-surface' : 'border-border-strong bg-surface',
                isLocked ? 'cursor-not-allowed' : cn('cursor-pointer', !checked && 'hover:bg-surface-muted'),
              )}
            >
              {/* The tile draws the focus ring; the box itself stays the control people tick. */}
              <input
                type="checkbox"
                checked={checked}
                disabled={isLocked}
                aria-describedby={isLocked ? lockId : undefined}
                onChange={(event) => toggle(option.role, event.target.checked)}
                className="size-5 shrink-0 cursor-pointer accent-accent-strong focus-visible:outline-none disabled:cursor-not-allowed"
              />
              <span aria-hidden="true" className={cn('flex size-8 shrink-0 items-center justify-center rounded-item', toneTileClasses[visual.tone])}>
                <Icon className="size-4" />
              </span>
              <span className={cn('min-w-0 flex-1 text-sm font-semibold break-words', isLocked ? 'text-fg-muted' : 'text-fg')}>{option.label}</span>
              {isLocked && <Lock aria-hidden="true" data-locked-role="" className="size-4 shrink-0 text-fg-muted" />}
              {checked && <Check aria-hidden="true" className="size-4 shrink-0 text-accent-text" />}
            </label>
          )
        })}
      </div>
      {locked && (
        <span id={lockId} className="sr-only">
          {locked.reason}
        </span>
      )}
      {error && (
        <p id={errorId} className="mt-1.5 flex items-start gap-1.5 text-sm font-medium text-danger-text">
          <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
        </p>
      )}
    </fieldset>
  )
}
