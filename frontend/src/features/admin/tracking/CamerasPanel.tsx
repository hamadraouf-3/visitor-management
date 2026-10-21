import type { TFunction } from 'i18next'
import { Archive, ArchiveRestore, DoorOpen, MapPinned, Pencil, Plus, Cctv } from 'lucide-react'
import { useRef, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Alert } from '../../../components/ui/Alert'
import { ApiErrorMessage } from '../../../components/ui/ApiErrorMessage'
import { Badge } from '../../../components/ui/Badge'
import { Button } from '../../../components/ui/Button'
import { Checkbox } from '../../../components/ui/Checkbox'
import { Dialog } from '../../../components/ui/Dialog'
import { EmptyState } from '../../../components/ui/EmptyState'
import { Field } from '../../../components/ui/Field'
import { Input } from '../../../components/ui/Input'
import { ListPanel } from '../../../components/ui/ListPanel'
import { LoadErrorAlert } from '../../../components/ui/LoadErrorAlert'
import { Select } from '../../../components/ui/Select'
import { Table, type TableColumn } from '../../../components/ui/Table'
import { useToast } from '../../../components/ui/toastContext'
import { useFormErrors } from '../../../hooks/useFormErrors'
import { FOCUS_ROW_ATTRIBUTE, ROW_ACTION_ATTRIBUTE, useListFocusRecovery } from '../../../hooks/useListFocusRecovery'
import { useStableId } from '../../../hooks/useStableId'
import { useUrlParams } from '../../../hooks/useUrlParams'
import type { Language } from '../../../i18n'
import { useLanguage } from '../../../i18n/useLanguage'
import type { TrackingCamera } from '../../../types/api'
import { cn } from '../../../utils/cn'
import { actionErrorMessage } from '../../../utils/forms'
import { LocationPath } from '../../journey/LocationPath'
import { locationName, type LocationNames } from '../../journey/locationNames'
import type { BuildingNode } from '../../journey/types'
import { useAdminCameras, useCreateCamera, useLocations, useUpdateCamera } from './queries'
import { activeZoneGroups, CAMERA_FIELDS, cameraValues, validateCamera, type CameraField, type CameraValues } from './trackingForms'

const SHOW_ARCHIVED_PARAM = 'archived'
/** The archive or restore button: where the focus goes on when an archived camera's row leaves the list. */
const ROW_ACTION = { [ROW_ACTION_ATTRIBUTE]: '' }

interface CameraColumnContext {
  onEdit: (camera: TrackingCamera) => void
  onArchive: (camera: TrackingCamera) => void
  onRestore: (camera: TrackingCamera) => void
  restoringId: string | null
}

function cameraColumns({ onEdit, onArchive, onRestore, restoringId }: CameraColumnContext, t: TFunction<'admin'>): TableColumn<TrackingCamera>[] {
  return [
    {
      id: 'name',
      header: t('tracking.cameras.columns.name'),
      primary: true,
      headerClassName: 'lg:w-[30%]',
      className: 'lg:align-middle',
      cell: (camera) => (
        <span className="flex min-w-0 items-center gap-3">
          <Cctv aria-hidden="true" className={cn('size-5 shrink-0', camera.is_active ? 'text-fg-secondary' : 'text-fg-muted opacity-60')} />
          <span className="flex min-w-0 flex-col">
            <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <span className={cn('text-[0.90625rem] font-semibold break-words', camera.is_active ? 'text-fg' : 'text-fg-muted')}>{camera.name}</span>
              {!camera.is_active && <Badge tone="neutral">{t('tracking.cameras.archived')}</Badge>}
            </span>
            <span dir="ltr" className="font-mono text-[0.78125rem] leading-snug font-normal break-all text-fg-muted [text-align:-webkit-match-parent] [text-align:match-parent]">
              {camera.provider_camera_id}
            </span>
          </span>
        </span>
      ),
    },
    {
      id: 'location',
      header: t('tracking.cameras.columns.location'),
      className: 'lg:align-middle',
      cell: (camera) => <LocationPath places={[camera.location.building, camera.location.floor, camera.location.zone]} className="text-fg" />,
    },
    {
      id: 'reception',
      header: t('tracking.cameras.columns.reception'),
      stacked: 'inline',
      headerClassName: 'lg:w-[9.5rem]',
      className: 'lg:align-middle',
      isEmpty: (camera) => !camera.is_enrollment_point,
      cell: (camera) =>
        camera.is_enrollment_point ? (
          <Badge tone="info" icon={DoorOpen}>
            {t('tracking.cameras.enrollmentPoint')}
          </Badge>
        ) : (
          <span className="text-fg-muted">—</span>
        ),
    },
    {
      id: 'actions',
      header: t('tracking.cameras.columns.actions'),
      headerHidden: true,
      align: 'end',
      headerClassName: 'lg:w-[15rem]',
      className: 'lg:align-middle',
      cell: (camera) => (
        <div {...{ [FOCUS_ROW_ATTRIBUTE]: camera.id }} className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" size="sm" icon={<Pencil aria-hidden="true" />} onClick={() => onEdit(camera)} aria-label={t('tracking.cameras.editNamed', { name: camera.name })}>
            {t('tracking.cameras.edit')}
          </Button>
          {camera.is_active ? (
            <Button {...ROW_ACTION} variant="secondary" size="sm" icon={<Archive aria-hidden="true" />} onClick={() => onArchive(camera)} aria-label={t('tracking.cameras.archiveNamed', { name: camera.name })}>
              {t('tracking.cameras.archive')}
            </Button>
          ) : (
            <Button
              {...ROW_ACTION}
              variant="secondary"
              size="sm"
              icon={<ArchiveRestore aria-hidden="true" />}
              loading={restoringId === camera.id}
              onClick={() => onRestore(camera)}
              aria-label={t('tracking.cameras.restoreNamed', { name: camera.name })}
            >
              {t('tracking.cameras.restore')}
            </Button>
          )}
        </div>
      ),
    },
  ]
}

/** "Tower A › Level 2" for the zone picker's groups. */
function groupLabel(building: LocationNames, floor: LocationNames, language: Language): string {
  return `${locationName(building, language)} › ${locationName(floor, language)}`
}

/**
 * Add or edit a camera: the provider's camera ID (as the provider reports it, left to right), its name, the
 * zone it covers (grouped by building and floor; active zones only), and whether it is a reception camera
 * (an enrollment point). No address, stream or credential: those stay with the provider.
 */
function CameraDialog({ camera, cameras, buildings, onClose }: { camera?: TrackingCamera; cameras: readonly TrackingCamera[]; buildings: readonly BuildingNode[]; onClose: () => void }) {
  const { t } = useTranslation('admin')
  const { language } = useLanguage()
  const toast = useToast()
  const create = useCreateCamera()
  const update = useUpdateCamera()
  const mutation = camera ? update : create
  const [values, setValues] = useState<CameraValues>(() => cameraValues(camera))
  const form = useFormErrors<CameraField>(mutation.error, { fields: CAMERA_FIELDS, codes: { CONFLICT: 'providerCameraId' } })
  const formId = useStableId('camera')
  const groups = activeZoneGroups(buildings)
  const set = <K extends keyof CameraValues>(key: K, value: CameraValues[K]) => setValues((current) => ({ ...current, [key]: value }))
  // The camera's zone, archived since: kept as the current choice, so an edit of its name does not move it.
  const currentZoneArchived = camera !== undefined && !groups.some((group) => group.zones.some((zone) => zone.id === camera.zone_id))

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!form.validate(validateCamera(values, cameras, camera?.id))) return
    const name = values.name.trim()
    const done = () => {
      toast.show({ tone: 'success', title: camera ? t('tracking.cameras.saved', { name }) : t('tracking.cameras.added', { name }) })
      onClose()
    }
    const body = { provider_camera_id: values.providerCameraId.trim(), name, zone_id: values.zoneId, is_enrollment_point: values.isEnrollmentPoint }
    if (!camera) {
      create.mutate(body, { onSuccess: done })
      return
    }
    const changed = {
      ...(body.provider_camera_id !== camera.provider_camera_id ? { provider_camera_id: body.provider_camera_id } : {}),
      ...(body.name !== camera.name ? { name: body.name } : {}),
      ...(body.zone_id !== camera.zone_id ? { zone_id: body.zone_id } : {}),
      ...(body.is_enrollment_point !== camera.is_enrollment_point ? { is_enrollment_point: body.is_enrollment_point } : {}),
    }
    if (Object.keys(changed).length === 0) onClose()
    else update.mutate({ id: camera.id, body: changed }, { onSuccess: done })
  }

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={camera ? t('tracking.cameras.editNamed', { name: camera.name }) : t('tracking.cameras.add')}
      dismissible={!mutation.isPending}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={mutation.isPending} focusableWhenDisabled>
            {t('tracking.cancel')}
          </Button>
          <Button type="submit" form={formId} loading={mutation.isPending}>
            {camera ? t('tracking.save') : t('tracking.add')}
          </Button>
        </>
      }
    >
      <form id={formId} noValidate onSubmit={handleSubmit} className="flex flex-col gap-4">
        {form.formError && <Alert tone="danger">{form.formError}</Alert>}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label={t('tracking.cameras.providerId')} required {...form.field('providerCameraId')}>
            <Input dir="ltr" autoComplete="off" spellCheck={false} className="font-mono" value={values.providerCameraId} onChange={(event) => set('providerCameraId', event.target.value)} />
          </Field>
          <Field label={t('tracking.cameras.name')} required {...form.field('name')}>
            <Input autoComplete="off" value={values.name} onChange={(event) => set('name', event.target.value)} />
          </Field>
        </div>
        <Field label={t('tracking.cameras.zone')} required {...form.field('zoneId')}>
          <Select value={values.zoneId} onChange={(event) => set('zoneId', event.target.value)}>
            <option value="">{t('tracking.cameras.chooseZone')}</option>
            {currentZoneArchived && camera && (
              <option value={camera.zone_id}>
                {`${groupLabel(camera.location.building, camera.location.floor, language)} › ${locationName(camera.location.zone, language)}`}
              </option>
            )}
            {groups.map((group) => (
              <optgroup key={group.floor.id} label={groupLabel(group.building, group.floor, language)}>
                {group.zones.map((zone) => (
                  <option key={zone.id} value={zone.id}>
                    {locationName(zone, language)}
                  </option>
                ))}
              </optgroup>
            ))}
          </Select>
        </Field>
        <Checkbox label={t('tracking.cameras.enrollmentPointLabel')} checked={values.isEnrollmentPoint} onChange={(event) => set('isEnrollmentPoint', event.target.checked)} />
      </form>
    </Dialog>
  )
}

function ArchiveCameraDialog({ camera, onClose, onArchived }: { camera: TrackingCamera; onClose: () => void; onArchived: () => void }) {
  const { t } = useTranslation('admin')
  const toast = useToast()
  const update = useUpdateCamera()
  return (
    <Dialog
      open
      role="alertdialog"
      onClose={onClose}
      dismissible={!update.isPending}
      title={t('tracking.cameras.archiveTitle', { name: camera.name })}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={update.isPending} focusableWhenDisabled>
            {t('tracking.cameras.keep')}
          </Button>
          <Button
            variant="danger"
            loading={update.isPending}
            onClick={() =>
              update.mutate(
                { id: camera.id, body: { is_active: false } },
                {
                  onSuccess: () => {
                    toast.show({ tone: 'success', title: t('tracking.cameras.archivedToast', { name: camera.name }) })
                    onArchived()
                    onClose()
                  },
                },
              )
            }
          >
            {t('tracking.cameras.archive')}
          </Button>
        </>
      }
    >
      {update.isError ? (
        <Alert tone="danger">
          <ApiErrorMessage error={update.error} outsideForm />
        </Alert>
      ) : undefined}
    </Dialog>
  )
}

/**
 * The cameras the provider reports by its own IDs (Phase 15): each with its name, the provider's camera ID,
 * the zone it covers and whether it is a reception camera; add, edit, archive and restore. A camera needs a
 * zone, so with no active zone yet the way to the locations is offered first.
 */
export function CamerasPanel({ onOpenLocations }: { onOpenLocations: () => void }) {
  const { t } = useTranslation('admin')
  const toast = useToast()
  const [params, updateParams] = useUrlParams()
  const showArchived = params.get(SHOW_ARCHIVED_PARAM) === '1'
  const cameras = useAdminCameras(showArchived)
  const locations = useLocations()
  const restore = useUpdateCamera()
  const [editing, setEditing] = useState<{ camera?: TrackingCamera } | null>(null)
  const [archiving, setArchiving] = useState<TrackingCamera | null>(null)
  const buildings = locations.data?.buildings ?? []
  const hasZones = activeZoneGroups(buildings).length > 0
  const rows = cameras.data ?? []
  const listRef = useRef<HTMLDivElement>(null)
  const addRef = useRef<HTMLButtonElement>(null)
  // An archived camera leaves the list (unless archived ones are shown): the focus goes on to the next row's action (F15-32).
  const recoverFocus = useListFocusRecovery({ list: listRef, fallback: addRef, version: cameras.data })

  const addButton = (
    <Button ref={addRef} icon={<Plus aria-hidden="true" />} disabled={!hasZones} focusableWhenDisabled onClick={() => setEditing({})}>
      {t('tracking.cameras.add')}
    </Button>
  )

  const onRestore = (camera: TrackingCamera) =>
    restore.mutate(
      { id: camera.id, body: { is_active: true } },
      {
        onSuccess: () => toast.show({ tone: 'success', title: t('tracking.cameras.restored', { name: camera.name }) }),
        // A camera whose zone is archived is refused (422 at `zone_id`): its own words, not "the highlighted fields".
        onError: (error) => toast.show({ tone: 'danger', title: t('tracking.cameras.restoreFailed', { name: camera.name }), description: actionErrorMessage(error) }),
      },
    )

  return (
    <div className="flex flex-col gap-4">
      {locations.data && !hasZones && (
        <EmptyState
          icon={MapPinned}
          title={t('tracking.cameras.noZones')}
          action={
            <Button variant="secondary" onClick={onOpenLocations}>
              {t('tracking.cameras.openLocations')}
            </Button>
          }
        />
      )}
      <ListPanel
        frameFrom="lg"
        toolbar={
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <Checkbox
              label={t('tracking.cameras.showArchived')}
              checked={showArchived}
              onChange={(event) => updateParams({ [SHOW_ARCHIVED_PARAM]: event.target.checked ? '1' : null })}
            />
            <div className="self-start sm:self-auto">{addButton}</div>
          </div>
        }
      >
        {cameras.isError ? (
          <LoadErrorAlert title={t('tracking.cameras.loadError')} error={cameras.error} onRetry={() => void cameras.refetch()} />
        ) : (
          <div ref={listRef}>
            <Table
              columns={cameraColumns(
                { onEdit: (camera) => setEditing({ camera }), onArchive: setArchiving, onRestore, restoringId: restore.isPending ? (restore.variables?.id ?? null) : null },
                t,
              )}
              rows={rows}
              getRowKey={(camera) => camera.id}
              caption={t('tracking.cameras.title')}
              loading={cameras.isPending}
              stackBelow="lg"
              layout="fixed"
              framed={false}
              empty={<EmptyState icon={Cctv} title={t('tracking.cameras.empty')} />}
            />
          </div>
        )}
      </ListPanel>
      {editing && <CameraDialog camera={editing.camera} cameras={rows} buildings={buildings} onClose={() => setEditing(null)} />}
      {archiving && <ArchiveCameraDialog key={archiving.id} camera={archiving} onClose={() => setArchiving(null)} onArchived={() => recoverFocus(archiving.id)} />}
    </div>
  )
}
