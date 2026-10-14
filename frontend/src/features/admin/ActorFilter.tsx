import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { isApiError } from '../../api/client'
import { queryKeys } from '../../api/queryKeys'
import { listUsers } from '../../api/users'
import { AsyncCombobox } from '../../components/ui/AsyncCombobox'
import { HighlightMatch } from '../../components/ui/HighlightMatch'
import type { User } from '../../types/api'
import { useUser } from './queries'

const SUGGESTIONS = 10

export interface ActorFilterProps {
  /** The selected actor's user ID (from the URL). */
  value: string | null
  onChange: (actorId: string | null) => void
}

/** A stand-in option while the selected actor's record is loading, or when it cannot be read. */
function placeholderUser(id: string, fullName: string): User {
  return {
    id,
    full_name: fullName,
    email: '',
    phone: null,
    roles: [],
    department: null,
    is_active: true,
    must_change_password: false,
    last_login_at: null,
    created_at: '',
    updated_at: '',
  }
}

/** Whether the actor's ID names no account the server knows (the filter then says "Unknown user"). */
function isUnknownActor(error: unknown): boolean {
  return isApiError(error) && (error.status === 404 || error.status === 422)
}

/**
 * Who performed the event: a search over every account of the company, active or not
 * (GET /users, administrators only), by name or email. The selected actor is shown by the name
 * the server has for its ID (GET /users/{id}): the URL holds the ID only, so a crafted link
 * cannot label one user's events with another's name. Use inside a `Field`.
 */
export function ActorFilter({ value, onChange }: ActorFilterProps) {
  const { t } = useTranslation('admin')
  const queryClient = useQueryClient()
  const actor = useUser(value)
  // What the filter calls the actor: the server's name for the ID, never one from the URL.
  const fallbackLabel = actor.isError
    ? isUnknownActor(actor.error)
      ? t('audit.actor.unknown')
      : t('audit.actor.selected')
    : t('audit.actor.loading')
  const selected = value === null ? null : actor.data?.id === value ? actor.data : placeholderUser(value, fallbackLabel)

  return (
    <AsyncCombobox<User>
      value={selected}
      onChange={(user) => {
        // The picked record is the one the filter will show: no second request for its name.
        if (user) queryClient.setQueryData(queryKeys.users.detail(user.id), user)
        onChange(user?.id ?? null)
      }}
      queryKey={(q) => [...queryKeys.users.all, 'actor-search', q]}
      fetchOptions={async (q, signal) => (await listUsers(q ? { q, page_size: SUGGESTIONS } : { page_size: SUGGESTIONS }, { signal })).items}
      getOptionKey={(user) => user.id}
      getOptionLabel={(user) => user.full_name}
      renderOption={(user, query) => (
        <span className="flex flex-col">
          <span className="font-medium">
            <HighlightMatch text={user.full_name} query={query} />
            {!user.is_active && <span className="font-normal text-fg-muted"> {t('audit.actor.inactive')}</span>}
          </span>
          {user.email && (
            <span className="text-xs wrap-anywhere text-fg-muted">
              <HighlightMatch text={user.email} query={query} />
            </span>
          )}
        </span>
      )}
      placeholder={t('audit.actor.anyone')}
      emptyMessage={t('audit.actor.empty')}
    />
  )
}
