import type { TFunction } from 'i18next'
import { Building, Pencil, Plus, Power, PowerOff } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { getErrorMessage } from '../../api/client'
import { Alert } from '../../components/ui/Alert'
import { ApiErrorMessage } from '../../components/ui/ApiErrorMessage'
import { Badge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { Checkbox } from '../../components/ui/Checkbox'
import { Dialog } from '../../components/ui/Dialog'
import { EmptyState } from '../../components/ui/EmptyState'
import { IconTile } from '../../components/ui/IconTile'
import { MetaLine } from '../../components/ui/MetaLine'
import { PageHeader } from '../../components/ui/PageHeader'
import { Table, type TableColumn } from '../../components/ui/Table'
import { useToast } from '../../components/ui/toastContext'
import { ListPanel } from '../../components/ui/ListPanel'
import { LoadErrorAlert } from '../../components/ui/LoadErrorAlert'
import { useUrlParams } from '../../hooks/useUrlParams'
import type { Language } from '../../i18n'
import { departmentOtherName, useDepartmentName } from '../../i18n/departmentName'
import { useLanguage } from '../../i18n/useLanguage'
import type { Department, Me } from '../../types/api'
import { cn } from '../../utils/cn'
import { formatDate } from '../../utils/datetime'
import { focusPageHeading, isFocusLost } from '../../utils/focus'
import { sortDepartments } from './departmentForm'
import { DepartmentNameDialog } from './DepartmentNameDialog'
import { useAllDepartments, useUpdateDepartment } from './queries'

const SHOW_INACTIVE_PARAM = 'inactive'

interface DepartmentColumnContext {
  timeZone: string
  language: Language
  /** The department's name in the UI language (`useDepartmentName`). */
  departmentName: (department: Department) => string
  onRename: (department: Department) => void
  onDeactivate: (department: Department) => void
  onReactivate: (department: Department) => void
  reactivatingId: string | null
}

function departmentColumns(
  { timeZone, language, departmentName, onRename, onDeactivate, onReactivate, reactivatingId }: DepartmentColumnContext,
  t: TFunction<'admin'>,
): TableColumn<Department>[] {
  return [
    {
      // Only the exception is flagged, as on the Users list: an inactive department's name is
      // muted and says "Inactive"; an active one carries no badge. The tile is decorative. The name
      // is the UI language's; the other language's name, when the department has both, is the muted
      // line under it (data the administrator manages, F10-dept-4).
      id: 'name',
      header: t('departments.columns.name'),
      primary: true,
      headerClassName: 'md:w-[48%]',
      className: 'md:align-middle',
      cell: (department) => {
        const other = departmentOtherName(department, language)
        return (
          <span className="flex min-w-0 items-center gap-3">
            <IconTile icon={Building} tone={department.is_active ? 'accent' : 'neutral'} className={cn(!department.is_active && 'opacity-70')} />
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                <span className={cn('text-[0.90625rem] font-semibold break-words', department.is_active ? 'text-fg' : 'text-fg-muted')}>
                  {departmentName(department)}
                </span>
                {!department.is_active && <Badge tone="neutral">{t('departments.inactive')}</Badge>}
              </span>
              {other && (
                // The other language's name in its own language and direction; normal weight in the phone card too.
                <span lang={language === 'ar' ? 'en' : 'ar'} dir="auto" className="text-[0.78125rem] leading-snug font-normal break-words text-fg-muted [text-align:-webkit-match-parent] [text-align:match-parent]">
                  {other}
                </span>
              )}
            </span>
          </span>
        )
      },
    },
    {
      id: 'updated',
      header: t('departments.columns.updated'),
      headerClassName: 'md:w-[20%]',
      className: 'md:align-middle',
      cell: (department) => <span className="text-fg-secondary tabular-nums">{formatDate(department.updated_at, timeZone)}</span>,
    },
    {
      id: 'actions',
      header: t('departments.columns.actions'),
      headerHidden: true,
      align: 'end',
      className: 'md:align-middle',
      cell: (department) => (
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            variant="secondary"
            size="sm"
            icon={<Pencil aria-hidden="true" />}
            onClick={() => onRename(department)}
            aria-label={t('departments.renameNamed', { name: departmentName(department) })}
          >
            {t('departments.rename')}
          </Button>
          {department.is_active ? (
            // Neutral on the page, where renaming and adding are the common tasks; the danger tone
            // is kept for the confirmation, where the deactivation actually happens.
            <Button
              variant="secondary"
              size="sm"
              icon={<PowerOff aria-hidden="true" />}
              onClick={() => onDeactivate(department)}
              aria-label={t('departments.deactivateNamed', { name: departmentName(department) })}
            >
              {t('departments.deactivate')}
            </Button>
          ) : (
            <Button
              variant="secondary"
              size="sm"
              icon={<Power aria-hidden="true" />}
              loading={reactivatingId === department.id}
              onClick={() => onReactivate(department)}
              aria-label={t('departments.reactivateNamed', { name: departmentName(department) })}
            >
              {t('departments.reactivate')}
            </Button>
          )}
        </div>
      ),
    },
  ]
}

function DeactivateDialog({ department, onClose, onDeactivated }: { department: Department; onClose: () => void; onDeactivated: () => void }) {
  const { t } = useTranslation('admin')
  const toast = useToast()
  const departmentName = useDepartmentName()
  const update = useUpdateDepartment()
  return (
    <Dialog
      open
      role="alertdialog"
      onClose={onClose}
      // The title alone: a deactivation can be undone (Reactivate), so no sentence explains it (decision 3).
      title={t('departments.deactivateTitle', { name: departmentName(department) })}
      dismissible={!update.isPending}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={update.isPending} focusableWhenDisabled>
            {t('departments.keepActive')}
          </Button>
          <Button
            variant="danger"
            loading={update.isPending}
            onClick={() =>
              update.mutate(
                { id: department.id, body: { is_active: false } },
                {
                  onSuccess: (saved) => {
                    toast.show({ tone: 'success', title: t('departments.deactivated', { name: departmentName(saved) }) })
                    onDeactivated()
                    onClose()
                  },
                },
              )
            }
          >
            {t('departments.deactivateConfirm')}
          </Button>
        </>
      }
    >
      {update.isError ? (
        <Alert tone="danger">
          <ApiErrorMessage error={update.error} />
        </Alert>
      ) : undefined}
    </Dialog>
  )
}

export interface DepartmentListProps {
  me: Me
}

/**
 * The departments people and visits belong to: create, rename, deactivate and reactivate them
 * (they are never deleted, D-12). Inactive ones are listed on request ("Show inactive
 * departments"); the header counts both.
 */
export function DepartmentList({ me }: DepartmentListProps) {
  const { t } = useTranslation('admin')
  const { language } = useLanguage()
  const departmentName = useDepartmentName()
  const toast = useToast()
  const departments = useAllDepartments()
  const reactivate = useUpdateDepartment()
  const [params, updateParams] = useUrlParams()
  const showInactive = params.get(SHOW_INACTIVE_PARAM) === '1'
  const [naming, setNaming] = useState<{ department?: Department } | null>(null)
  const [deactivating, setDeactivating] = useState<Department | null>(null)
  // A deactivated department leaves the list when inactive ones are hidden, and with it the
  // focused button: focus then continues from the page heading instead of the document.
  const leavingId = useRef<string | null>(null)
  const all = departments.data ?? []
  const rows = sortDepartments(showInactive ? all : all.filter((department) => department.is_active), language)

  useEffect(() => {
    const id = leavingId.current
    // Wait for the refreshed list: until then the department still shows as active.
    if (id === null || departments.data?.find((department) => department.id === id)?.is_active) return
    leavingId.current = null
    if (isFocusLost()) focusPageHeading()
  }, [departments.data])

  const inactiveCount = all.filter((department) => !department.is_active).length
  const addButton = (
    <Button icon={<Plus aria-hidden="true" />} onClick={() => setNaming({})}>
      {t('departments.add')}
    </Button>
  )

  const onReactivate = (department: Department) =>
    reactivate.mutate(
      { id: department.id, body: { is_active: true } },
      {
        onSuccess: (saved) => toast.show({ tone: 'success', title: t('departments.reactivated', { name: departmentName(saved) }) }),
        onError: (error) =>
          toast.show({ tone: 'danger', title: t('departments.reactivateFailed', { name: departmentName(department) }), description: getErrorMessage(error) }),
      },
    )

  return (
    <>
      <PageHeader
        title={t('departments.title')}
        meta={
          departments.data ? (
            <MetaLine
              items={[
                <span key="active" className="tabular-nums">
                  {t('departments.activeTotal', { count: all.length - inactiveCount })}
                </span>,
                inactiveCount > 0 && (
                  <span key="inactive" className="tabular-nums">
                    {t('departments.inactiveTotal', { count: inactiveCount })}
                  </span>
                ),
              ]}
            />
          ) : undefined
        }
        actions={addButton}
        mobileActions={addButton}
      />

      {/* One card, as every list of the app: its filter as the header row, then the departments. */}
      <ListPanel
        frameFrom="md"
        toolbar={
          <Checkbox
            label={departments.data ? t('departments.showInactiveCount', { count: inactiveCount }) : t('departments.showInactive')}
            checked={showInactive}
            onChange={(event) => updateParams({ [SHOW_INACTIVE_PARAM]: event.target.checked ? '1' : null })}
          />
        }
      >
        {departments.isError ? (
          <LoadErrorAlert title={t('departments.loadError')} error={departments.error} onRetry={() => void departments.refetch()} />
        ) : (
          <Table
            columns={departmentColumns({
              timeZone: me.company.timezone,
              language,
              departmentName,
              onRename: (department) => setNaming({ department }),
              onDeactivate: setDeactivating,
              onReactivate,
              reactivatingId: reactivate.isPending ? (reactivate.variables?.id ?? null) : null,
            }, t)}
            rows={rows}
            getRowKey={(department) => department.id}
            caption={t('departments.title')}
            loading={departments.isPending}
            layout="fixed"
            framed={false}
            empty={
              <EmptyState
                icon={Building}
                title={all.length > 0 ? t('departments.empty.noneActiveTitle') : t('departments.empty.title')}
                action={addButton}
              />
            }
          />
        )}
      </ListPanel>

      {naming && <DepartmentNameDialog department={naming.department} departments={all} onClose={() => setNaming(null)} />}
      {deactivating && (
        <DeactivateDialog
          key={deactivating.id}
          department={deactivating}
          onDeactivated={() => {
            leavingId.current = deactivating.id
          }}
          onClose={() => setDeactivating(null)}
        />
      )}
    </>
  )
}
