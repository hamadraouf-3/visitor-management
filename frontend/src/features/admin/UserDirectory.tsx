import type { TFunction } from 'i18next'
import { KeyRound, Pencil, SearchX, UserPlus, UsersRound } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ALL_ROLES, GROUP_ROLE_LABELS, PERSON_ROLE_LABELS } from '../../auth/roles'
import { Avatar } from '../../components/ui/Avatar'
import { Badge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { CellStack } from '../../components/ui/CellStack'
import { EmailText } from '../../components/ui/EmailText'
import { EmptyState } from '../../components/ui/EmptyState'
import { ListPanel } from '../../components/ui/ListPanel'
import { LoadErrorAlert } from '../../components/ui/LoadErrorAlert'
import { MetaLine } from '../../components/ui/MetaLine'
import { PageHeader } from '../../components/ui/PageHeader'
import { Pagination } from '../../components/ui/Pagination'
import { SearchField } from '../../components/ui/SearchField'
import { Select } from '../../components/ui/Select'
import { Table, type TableColumn } from '../../components/ui/Table'
import { useNow } from '../../hooks/useNow'
import { useSearchInput } from '../../hooks/useSearchInput'
import { useDepartmentName } from '../../i18n/departmentName'
import { pageParamValue, readPageParam, useUrlParams } from '../../hooks/useUrlParams'
import type { Me, Role, User } from '../../types/api'
import { cn } from '../../utils/cn'
import { formatRelativeDateTime } from '../../utils/datetime'
import { CreateUserDialog } from './CreateUserDialog'
import { EditUserDialog } from './EditUserDialog'
import { useUserList } from './queries'
import { readUserFilters, USER_STATUS_FILTER_LABELS, USER_STATUS_FILTERS, userFilterChanges, userListParams, USERS_PAGE_SIZE, type UserFilters } from './userFilters'
import { orderedRoles } from './userForm'

interface UserColumnContext {
  timeZone: string
  now: number
  currentUserId: string
  onEdit: (user: User) => void
  /** The department's name in the UI language (`useDepartmentName`). */
  departmentName: (department: User['department']) => string
}

function userColumns({ timeZone, now, currentUserId, onEdit, departmentName, t }: UserColumnContext & { t: TFunction<'admin'> }): TableColumn<User>[] {
  return [
    {
      // Direction C's person cell: the initials tile, the name with what sets the account apart
      // beside it (an inactive account is muted and says "Inactive"; a temporary password not yet
      // replaced says so), and the e-mail address under it.
      id: 'name',
      header: t('users.columns.name'),
      primary: true,
      headerClassName: 'xl:w-[34%]',
      className: 'xl:align-middle',
      cell: (user) => (
        <CellStack
          leading={<Avatar name={user.full_name} className={cn(!user.is_active && 'border border-dashed border-border-strong')} />}
          primary={
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className={cn('break-words', user.is_active ? 'text-fg' : 'text-fg-muted')}>
                {user.full_name}
                {user.id === currentUserId && <span className="font-normal text-fg-muted"> {t('users.you')}</span>}
              </span>
              {!user.is_active && <Badge tone="neutral">{t('users.inactive')}</Badge>}
              {user.is_active && user.must_change_password && (
                <Badge tone="warning" icon={KeyRound}>
                  {t('users.temporaryPassword')}
                </Badge>
              )}
            </span>
          }
          // The stacked card sets its title cell in semibold; the address keeps the regular weight.
          secondary={<EmailText address={user.email} className="font-normal" />}
        />
      ),
    },
    {
      id: 'roles',
      header: t('users.columns.roles'),
      headerClassName: 'xl:w-[21%]',
      className: 'xl:align-middle',
      cell: (user) => (
        <div className="flex flex-wrap gap-1">
          {orderedRoles(user.roles).map((role) => (
            <Badge key={role} tone={role === 'SYSTEM_ADMIN' ? 'accent' : 'neutral'}>
              {PERSON_ROLE_LABELS[role]}
            </Badge>
          ))}
        </div>
      ),
    },
    {
      id: 'department',
      header: t('users.columns.department'),
      headerClassName: 'xl:w-[17%]',
      className: 'xl:align-middle',
      isEmpty: (user) => user.department === null,
      cell: (user) => (user.department ? <span className="break-words text-fg-secondary">{departmentName(user.department)}</span> : <span className="text-fg-muted">—</span>),
    },
    {
      id: 'lastSignIn',
      header: t('users.lastSignIn'),
      headerClassName: 'xl:w-[16%]',
      className: 'xl:align-middle',
      cell: (user) =>
        user.last_login_at ? (
          <span className="text-fg-secondary tabular-nums">{formatRelativeDateTime(user.last_login_at, timeZone, now)}</span>
        ) : (
          <span className="text-fg-muted">{t('users.neverSignedIn')}</span>
        ),
    },
    {
      id: 'actions',
      header: t('users.columns.actions'),
      headerClassName: 'xl:w-[12%]',
      className: 'xl:align-middle',
      headerHidden: true,
      align: 'end',
      cell: (user) => (
        <Button
          variant="secondary"
          size="sm"
          icon={<Pencil aria-hidden="true" />}
          onClick={() => onEdit(user)}
          aria-label={t('users.editNamed', { name: user.full_name })}
        >
          {t('users.edit')}
        </Button>
      ),
    },
  ]
}

function roleFilterValue(raw: string): Role | null {
  return (ALL_ROLES as readonly string[]).includes(raw) ? (raw as Role) : null
}

export interface UserDirectoryProps {
  me: Me
}

/**
 * Every account of the company, searchable by name or email, filtered by role and status (in
 * the URL; the search text in the history entry's state, `useUrlParams`), with "Add user" in the
 * header and each account's edit dialog.
 */
export function UserDirectory({ me }: UserDirectoryProps) {
  const { t } = useTranslation('admin')
  const departmentName = useDepartmentName()
  const now = useNow()
  const [params, updateParams] = useUrlParams()
  const filters = readUserFilters(params)
  const page = readPageParam(params)
  const users = useUserList(userListParams(filters, page))
  const applyFilters = (changes: Partial<UserFilters>) => updateParams(userFilterChanges(changes))
  const search = useSearchInput(filters.q, (q) => applyFilters({ q }))
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<User | null>(null)

  const data = users.data
  const filtered = filters.q !== '' || filters.role !== null || filters.status !== 'all'
  const addUser = (
    <Button icon={<UserPlus aria-hidden="true" />} onClick={() => setCreating(true)}>
      {t('users.add')}
    </Button>
  )

  return (
    <>
      <PageHeader
        title={t('users.title')}
        meta={data && !users.isPlaceholderData ? <MetaLine items={[<span key="total" className="tabular-nums">{t('users.total', { count: data.total })}</span>]} /> : undefined}
        actions={addUser}
        mobileActions={addUser}
      />

      {/* The list as one card, as every searchable list of the app (My visits, Visitors): the search
          and the two filters as its header row, the accounts, the pagination. Below 1280 px each
          account is a card of its own and the parts stack. */}
      <ListPanel
        frameFrom="xl"
        toolbar={
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_12rem_14rem] sm:items-center">
            <SearchField
              label={t('users.search.label')}
              labelHidden
              placeholder={t('users.search.placeholder')}
              value={search.text}
              onValueChange={search.setText}
              onSubmit={search.commitNow}
              onClear={search.clear}
              className="min-w-0 xl:max-w-md"
            />
            <Select
              aria-label={t('users.filters.role')}
              value={filters.role ?? ''}
              onChange={(event) => applyFilters({ role: roleFilterValue(event.target.value) })}
            >
              <option value="">{t('users.filters.allRoles')}</option>
              {ALL_ROLES.map((role) => (
                <option key={role} value={role}>
                  {GROUP_ROLE_LABELS[role]}
                </option>
              ))}
            </Select>
            <Select
              aria-label={t('users.filters.status')}
              value={filters.status}
              onChange={(event) => applyFilters({ status: USER_STATUS_FILTERS.find((status) => status === event.target.value) ?? 'all' })}
            >
              {USER_STATUS_FILTERS.map((status) => (
                <option key={status} value={status}>
                  {USER_STATUS_FILTER_LABELS[status]}
                </option>
              ))}
            </Select>
          </div>
        }
        footer={
          !users.isError &&
          data &&
          data.total > 0 && (
            <Pagination
              page={page}
              pageSize={USERS_PAGE_SIZE}
              total={data.total}
              label={t('users.pagesLabel')}
              onPageChange={(next) => updateParams({ page: pageParamValue(next) })}
            />
          )
        }
      >
        {users.isError ? (
          <LoadErrorAlert title={t('users.loadError')} error={users.error} onRetry={() => void users.refetch()} />
        ) : (
          <Table
            columns={userColumns({ timeZone: me.company.timezone, now, currentUserId: me.user.id, onEdit: setEditing, departmentName, t })}
            rows={data?.items ?? []}
            getRowKey={(user) => user.id}
            caption={t('users.title')}
            loading={users.isPending || users.isPlaceholderData}
            // Five columns need the width a 1280 px screen leaves beside the sidebar: below it,
            // each account is a card (two per row from md).
            stackBelow="xl"
            layout="fixed-xl"
            framed={false}
            empty={
              filtered ? (
                <EmptyState
                  icon={SearchX}
                  title={t('users.empty.filteredTitle')}
                  action={
                    <Button
                      variant="secondary"
                      onClick={() => {
                        search.clear()
                        applyFilters({ q: '', role: null, status: 'all' })
                      }}
                    >
                      {t('users.filters.clear')}
                    </Button>
                  }
                />
              ) : (
                <EmptyState icon={UsersRound} title={t('users.empty.title')} action={addUser} />
              )
            }
          />
        )}
      </ListPanel>

      {creating && <CreateUserDialog onClose={() => setCreating(false)} />}
      {editing && <EditUserDialog key={editing.id} user={editing} currentUserId={me.user.id} onClose={() => setEditing(null)} />}
    </>
  )
}
