import { Archive, ArchiveRestore, Building2, Ellipsis, Layers, MapPinned, Pencil, Plus } from 'lucide-react'
import { useRef, useState, type FormEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Alert } from '../../../components/ui/Alert'
import { ApiErrorMessage } from '../../../components/ui/ApiErrorMessage'
import { Badge } from '../../../components/ui/Badge'
import { Button } from '../../../components/ui/Button'
import { Card } from '../../../components/ui/Card'
import { Checkbox } from '../../../components/ui/Checkbox'
import { Dialog } from '../../../components/ui/Dialog'
import { EmptyState } from '../../../components/ui/EmptyState'
import { Field } from '../../../components/ui/Field'
import { Input } from '../../../components/ui/Input'
import { LoadErrorAlert } from '../../../components/ui/LoadErrorAlert'
import { Menu, type MenuItem } from '../../../components/ui/Menu'
import { Select } from '../../../components/ui/Select'
import { PageSpinner } from '../../../components/ui/Spinner'
import { useToast } from '../../../components/ui/toastContext'
import { useFormErrors } from '../../../hooks/useFormErrors'
import { FOCUS_ROW_ATTRIBUTE, useListFocusRecovery } from '../../../hooks/useListFocusRecovery'
import { useStableId } from '../../../hooks/useStableId'
import { useUrlParams } from '../../../hooks/useUrlParams'
import { useLanguage } from '../../../i18n/useLanguage'
import { cn } from '../../../utils/cn'
import { actionErrorMessage } from '../../../utils/forms'
import { locationName, otherLocationName, type LocationNames } from '../../journey/locationNames'
import type { BuildingNode, FloorNode } from '../../journey/types'
import { ZoneAccessBadge } from '../../journey/ZoneAccessBadge'
import { isZoneAccess, ZONE_ACCESS_LEVELS, ZONE_ACCESS_META } from '../../journey/zoneAccess'
import {
  useCreateBuilding,
  useCreateFloor,
  useCreateZone,
  useLocations,
  useUpdateBuilding,
  useUpdateFloor,
  useUpdateZone,
} from './queries'
import { parseLevel, PLACE_FIELDS, validatePlace, type PlaceField, type PlaceKind, type PlaceSiblings, type PlaceValues } from './trackingForms'

const SHOW_ARCHIVED_PARAM = 'archived'

type ZoneNode = FloorNode['zones'][number]

/** A place being added under its parent, or edited. */
type PlaceTarget =
  | { kind: 'building'; place?: BuildingNode }
  | { kind: 'floor'; building: BuildingNode; place?: FloorNode }
  | { kind: 'zone'; floor: FloorNode; place?: ZoneNode }

type ArchiveTarget = { kind: PlaceKind; place: BuildingNode | FloorNode | ZoneNode }

/**
 * A place's name in the UI language, and its other language's name under it, muted (data the administrator
 * manages). `marks`: chips beside the name (a zone's access level).
 */
function PlaceName({ place, className, marks }: { place: LocationNames & { is_active: boolean }; className?: string; marks?: ReactNode }) {
  const { t } = useTranslation('admin')
  const { language } = useLanguage()
  const other = otherLocationName(place, language)
  return (
    <span className="flex min-w-0 flex-col">
      <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span className={cn('font-semibold break-words', place.is_active ? 'text-fg' : 'text-fg-muted', className)}>{locationName(place, language)}</span>
        {marks}
        {!place.is_active && <Badge tone="neutral">{t('tracking.locations.archived')}</Badge>}
      </span>
      {other && (
        <span lang={language === 'ar' ? 'en' : 'ar'} dir="auto" className="text-[0.78125rem] leading-snug break-words text-fg-muted [text-align:-webkit-match-parent] [text-align:match-parent]">
          {other}
        </span>
      )}
    </span>
  )
}

/**
 * One menu per place: what can be done to it (add the next level down, edit, archive or restore). Each menu is
 * a row of the focus recovery (`placeId`): when an archived place leaves the tree, the focus goes on to the next
 * place's menu (F15-32).
 */
function PlaceMenu({ placeId, name, items, quiet = false }: { placeId: string; name: string; items: MenuItem[]; quiet?: boolean }) {
  const { t } = useTranslation('admin')
  return (
    <div {...{ [FOCUS_ROW_ATTRIBUTE]: placeId }} className="contents">
      <Menu
        items={items}
        align="end"
        triggerLabel={t('tracking.locations.actionsFor', { name })}
        trigger={<Ellipsis aria-hidden="true" className="size-5" />}
        // A building's menu is outlined; its floors' and zones' are quieter, so the tree reads before its buttons.
        triggerClassName={cn(
          'flex size-11 shrink-0 items-center justify-center rounded-control text-fg hover:bg-surface-muted',
          quiet ? 'text-fg-secondary' : 'border border-border-strong bg-surface',
        )}
      />
    </div>
  )
}

function siblingsOf(target: PlaceTarget, buildings: readonly BuildingNode[]): PlaceSiblings {
  switch (target.kind) {
    case 'building':
      return { names: buildings }
    case 'floor':
      return { names: target.building.floors, levels: target.building.floors }
    case 'zone':
      return { names: target.floor.zones }
  }
}

/** Add or edit a place: its name, its Arabic name (typed right to left), a floor's level, and a zone's access level (Phase 16). */
function PlaceDialog({ target, buildings, onClose }: { target: PlaceTarget; buildings: readonly BuildingNode[]; onClose: () => void }) {
  const { t } = useTranslation('admin')
  const { language } = useLanguage()
  const toast = useToast()
  const createBuilding = useCreateBuilding()
  const updateBuilding = useUpdateBuilding()
  const createFloor = useCreateFloor()
  const updateFloor = useUpdateFloor()
  const createZone = useCreateZone()
  const updateZone = useUpdateZone()
  const place = target.place
  const editing = place !== undefined
  const mutation = {
    building: editing ? updateBuilding : createBuilding,
    floor: editing ? updateFloor : createFloor,
    zone: editing ? updateZone : createZone,
  }[target.kind]
  const [values, setValues] = useState<PlaceValues>({
    name: place?.name ?? '',
    nameAr: place?.name_ar ?? '',
    level: target.kind === 'floor' && target.place ? String(target.place.level) : '',
    access: target.kind === 'zone' && target.place ? target.place.access : 'STANDARD',
  })
  // A 409 names the field whose value is taken (`details.field`: the name, or a floor's level).
  const conflictField = target.kind === 'floor' ? 'level' : 'name'
  const form = useFormErrors<PlaceField>(mutation.error, { fields: PLACE_FIELDS, codes: { CONFLICT: conflictField } })
  const formId = useStableId('place')
  const set = <K extends keyof PlaceValues>(key: K, value: PlaceValues[K]) => setValues((current) => ({ ...current, [key]: value }))

  const title = editing
    ? t(`tracking.locations.edit.${target.kind}`, { name: locationName(place, language) })
    : target.kind === 'floor'
      ? t('tracking.locations.add.floorIn', { name: locationName(target.building, language) })
      : target.kind === 'zone'
        ? t('tracking.locations.add.zoneIn', { name: locationName(target.floor, language) })
        : t('tracking.locations.add.building')

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!form.validate(validatePlace(target.kind, values, siblingsOf(target, buildings), place?.id))) return
    const name = values.name.trim()
    const nameAr = values.nameAr.trim() || null
    const done = () => {
      toast.show({ tone: 'success', title: editing ? t('tracking.locations.saved', { name }) : t('tracking.locations.added', { name }) })
      onClose()
    }
    if (target.kind === 'building') {
      if (target.place) updateBuilding.mutate({ id: target.place.id, body: { name, name_ar: nameAr } }, { onSuccess: done })
      else createBuilding.mutate({ name, name_ar: nameAr }, { onSuccess: done })
    } else if (target.kind === 'floor') {
      const level = parseLevel(values.level) ?? 0
      if (target.place) updateFloor.mutate({ id: target.place.id, body: { name, name_ar: nameAr, level } }, { onSuccess: done })
      else createFloor.mutate({ building_id: target.building.id, name, name_ar: nameAr, level }, { onSuccess: done })
    } else if (target.place) updateZone.mutate({ id: target.place.id, body: { name, name_ar: nameAr, access: values.access } }, { onSuccess: done })
    else createZone.mutate({ floor_id: target.floor.id, name, name_ar: nameAr, access: values.access }, { onSuccess: done })
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      dismissible={!mutation.isPending}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={mutation.isPending} focusableWhenDisabled>
            {t('tracking.cancel')}
          </Button>
          <Button type="submit" form={formId} loading={mutation.isPending}>
            {editing ? t('tracking.save') : t('tracking.add')}
          </Button>
        </>
      }
    >
      <form id={formId} noValidate onSubmit={handleSubmit} className="flex flex-col gap-4">
        {form.formError && <Alert tone="danger">{form.formError}</Alert>}
        <Field label={t('tracking.locations.name')} required {...form.field('name')}>
          <Input autoComplete="off" value={values.name} onChange={(event) => set('name', event.target.value)} />
        </Field>
        <Field label={t('tracking.locations.nameAr')} optional {...form.field('nameAr')}>
          <Input dir="rtl" lang="ar" autoComplete="off" value={values.nameAr} onChange={(event) => set('nameAr', event.target.value)} />
        </Field>
        {target.kind === 'floor' && (
          <Field label={t('tracking.locations.level')} required {...form.field('level')}>
            <Input dir="ltr" inputMode="numeric" autoComplete="off" className="max-w-28" value={values.level} onChange={(event) => set('level', event.target.value)} />
          </Field>
        )}
        {target.kind === 'zone' && (
          <Field label={t('tracking.locations.access')} {...form.field('access')}>
            <Select value={values.access} onChange={(event) => isZoneAccess(event.target.value) && set('access', event.target.value)} className="sm:max-w-60">
              {ZONE_ACCESS_LEVELS.map((access) => (
                <option key={access} value={access}>
                  {ZONE_ACCESS_META[access].label}
                </option>
              ))}
            </Select>
          </Field>
        )}
      </form>
    </Dialog>
  )
}

/** Archiving a place, after one line (it can be restored); refused while it holds active places or cameras. */
function ArchiveDialog({ target, onClose, onArchived }: { target: ArchiveTarget; onClose: () => void; onArchived: () => void }) {
  const { t } = useTranslation('admin')
  const { language } = useLanguage()
  const toast = useToast()
  const building = useUpdateBuilding()
  const floor = useUpdateFloor()
  const zone = useUpdateZone()
  const mutation = { building, floor, zone }[target.kind]
  const name = locationName(target.place, language)
  const archive = () => {
    const done = { onSuccess: () => {
      toast.show({ tone: 'success', title: t('tracking.locations.archivedToast', { name }) })
      onArchived()
      onClose()
    } }
    const body = { is_active: false }
    if (target.kind === 'building') building.mutate({ id: target.place.id, body }, done)
    else if (target.kind === 'floor') floor.mutate({ id: target.place.id, body }, done)
    else zone.mutate({ id: target.place.id, body }, done)
  }
  return (
    <Dialog
      open
      role="alertdialog"
      onClose={onClose}
      dismissible={!mutation.isPending}
      title={t('tracking.locations.archiveTitle', { name })}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={mutation.isPending} focusableWhenDisabled>
            {t('tracking.locations.keep')}
          </Button>
          <Button variant="danger" loading={mutation.isPending} onClick={archive}>
            {t('tracking.locations.archive')}
          </Button>
        </>
      }
    >
      {mutation.isError ? (
        <Alert tone="danger">
          <ApiErrorMessage error={mutation.error} outsideForm />
        </Alert>
      ) : undefined}
    </Dialog>
  )
}

interface TreeActions {
  edit: (target: PlaceTarget) => void
  archive: (target: ArchiveTarget) => void
  restore: (target: ArchiveTarget) => void
}

function placeItems(kind: PlaceKind, place: { is_active: boolean }, onEdit: () => void, onArchive: () => void, onRestore: () => void, t: (key: 'tracking.locations.editAction' | 'tracking.locations.archive' | 'tracking.locations.restore') => string): MenuItem[] {
  return [
    { id: `edit-${kind}`, label: t('tracking.locations.editAction'), icon: Pencil, onSelect: onEdit },
    place.is_active
      ? { id: `archive-${kind}`, label: t('tracking.locations.archive'), icon: Archive, onSelect: onArchive, tone: 'danger' }
      : { id: `restore-${kind}`, label: t('tracking.locations.restore'), icon: ArchiveRestore, onSelect: onRestore },
  ]
}

function ZoneRow({ zone, floor, actions }: { zone: ZoneNode; floor: FloorNode; actions: TreeActions }) {
  const { t } = useTranslation('admin')
  const { language } = useLanguage()
  return (
    <li data-place="zone" className="flex min-h-14 items-center gap-3 py-2 ps-4">
      <MapPinned aria-hidden="true" className={cn('size-4 shrink-0', zone.is_active ? 'text-fg-muted' : 'text-fg-muted opacity-60')} />
      <div className="min-w-0 flex-1 text-sm">
        {/* The editor names every zone's access level, the default one too (the map marks only common and restricted). */}
        <PlaceName place={zone} marks={<ZoneAccessBadge access={zone.access} always />} />
      </div>
      <PlaceMenu
        quiet
        placeId={zone.id}
        name={locationName(zone, language)}
        items={placeItems(
          'zone',
          zone,
          () => actions.edit({ kind: 'zone', floor, place: zone }),
          () => actions.archive({ kind: 'zone', place: zone }),
          () => actions.restore({ kind: 'zone', place: zone }),
          t,
        )}
      />
    </li>
  )
}

function FloorSection({ floor, building, showArchived, actions }: { floor: FloorNode; building: BuildingNode; showArchived: boolean; actions: TreeActions }) {
  const { t } = useTranslation('admin')
  const { language } = useLanguage()
  const zones = showArchived ? floor.zones : floor.zones.filter((zone) => zone.is_active)
  const name = locationName(floor, language)
  return (
    <li data-place="floor" className="py-3">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          {/* The level in words beside the name, never a bare number in a tile, which read as a count (the owner's follow-up, F16-32). */}
          <PlaceName
            place={floor}
            marks={
              <span data-floor-level={floor.level} className="inline-flex max-w-full">
                <Badge tone="neutral">
                  {t('tracking.locations.level')} <bdi dir="ltr">{floor.level}</bdi>
                </Badge>
              </span>
            }
          />
        </div>
        <PlaceMenu
          quiet
          placeId={floor.id}
          name={name}
          items={[
            ...(floor.is_active ? [{ id: 'add-zone', label: t('tracking.locations.add.zone'), icon: Plus, onSelect: () => actions.edit({ kind: 'zone', floor }) }] : []),
            ...placeItems(
              'floor',
              floor,
              () => actions.edit({ kind: 'floor', building, place: floor }),
              () => actions.archive({ kind: 'floor', place: floor }),
              () => actions.restore({ kind: 'floor', place: floor }),
              t,
            ),
          ]}
        />
      </div>
      {zones.length > 0 ? (
        <ul aria-label={t('tracking.locations.zonesOf', { name })} className="ms-5 mt-1 divide-y divide-border-subtle border-s border-border">
          {zones.map((zone) => (
            <ZoneRow key={zone.id} zone={zone} floor={floor} actions={actions} />
          ))}
        </ul>
      ) : (
        floor.is_active && (
          <div className="ms-5 mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 border-s border-border ps-4">
            <span className="text-sm text-fg-muted">{t('tracking.locations.noZones')}</span>
            <Button variant="ghost" size="sm" icon={<Plus aria-hidden="true" />} onClick={() => actions.edit({ kind: 'zone', floor })}>
              {t('tracking.locations.add.zone')}
            </Button>
          </div>
        )
      )}
    </li>
  )
}

function BuildingCard({ building, showArchived, actions }: { building: BuildingNode; showArchived: boolean; actions: TreeActions }) {
  const { t } = useTranslation('admin')
  const { language } = useLanguage()
  const floors = showArchived ? building.floors : building.floors.filter((floor) => floor.is_active)
  const name = locationName(building, language)
  return (
    <Card
      title={
        <span className="flex min-w-0 items-center gap-2.5">
          <Building2 aria-hidden="true" className="size-5 shrink-0 text-fg-muted" />
          <PlaceName place={building} />
        </span>
      }
      actions={
        <PlaceMenu
          placeId={building.id}
          name={name}
          items={[
            ...(building.is_active ? [{ id: 'add-floor', label: t('tracking.locations.add.floor'), icon: Layers, onSelect: () => actions.edit({ kind: 'floor', building }) }] : []),
            ...placeItems(
              'building',
              building,
              () => actions.edit({ kind: 'building', place: building }),
              () => actions.archive({ kind: 'building', place: building }),
              () => actions.restore({ kind: 'building', place: building }),
              t,
            ),
          ]}
        />
      }
    >
      {floors.length > 0 ? (
        <ul data-building={building.id} aria-label={t('tracking.locations.floorsOf', { name })} className="-my-3 divide-y divide-border-subtle">
          {floors.map((floor) => (
            <FloorSection key={floor.id} floor={floor} building={building} showArchived={showArchived} actions={actions} />
          ))}
        </ul>
      ) : (
        building.is_active && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="text-sm text-fg-muted">{t('tracking.locations.noFloors')}</span>
            <Button variant="ghost" size="sm" icon={<Plus aria-hidden="true" />} onClick={() => actions.edit({ kind: 'floor', building })}>
              {t('tracking.locations.add.floor')}
            </Button>
          </div>
        )
      )}
    </Card>
  )
}

/**
 * The company's places (Phase 15): its buildings, each with its floors by level and each floor's zones,
 * the shape a camera's location and a visitor's journey are said in (floor › zone, never coordinates).
 * Add, rename and archive; nothing is deleted, as a camera or an event may name it. Archived places are
 * shown on request, and can be restored. Editable whether tracking is on or not, so the places can be
 * prepared first.
 */
export function LocationsPanel() {
  const { t } = useTranslation('admin')
  const { language } = useLanguage()
  const toast = useToast()
  const locations = useLocations()
  const restoreBuilding = useUpdateBuilding()
  const restoreFloor = useUpdateFloor()
  const restoreZone = useUpdateZone()
  const [params, updateParams] = useUrlParams()
  const showArchived = params.get(SHOW_ARCHIVED_PARAM) === '1'
  const [editing, setEditing] = useState<PlaceTarget | null>(null)
  const [archiving, setArchiving] = useState<ArchiveTarget | null>(null)
  const buildings = locations.data?.buildings ?? []
  const shown = showArchived ? buildings : buildings.filter((building) => building.is_active)
  const treeRef = useRef<HTMLDivElement>(null)
  const addRef = useRef<HTMLButtonElement>(null)
  const recoverFocus = useListFocusRecovery({ list: treeRef, fallback: addRef, version: locations.data })

  const actions: TreeActions = {
    edit: setEditing,
    archive: setArchiving,
    restore: ({ kind, place }) => {
      const name = locationName(place, language)
      const done = {
        onSuccess: () => toast.show({ tone: 'success', title: t('tracking.locations.restored', { name }) }),
        // Under an archived parent it is refused (422 `location_archived`): its own words, not "the highlighted fields".
        onError: (error: unknown) => toast.show({ tone: 'danger', title: t('tracking.locations.restoreFailed', { name }), description: actionErrorMessage(error) }),
      }
      const body = { is_active: true }
      if (kind === 'building') restoreBuilding.mutate({ id: place.id, body }, done)
      else if (kind === 'floor') restoreFloor.mutate({ id: place.id, body }, done)
      else restoreZone.mutate({ id: place.id, body }, done)
    },
  }

  const addBuilding = (
    <Button ref={addRef} icon={<Plus aria-hidden="true" />} onClick={() => setEditing({ kind: 'building' })}>
      {t('tracking.locations.add.building')}
    </Button>
  )

  if (locations.isError) return <LoadErrorAlert title={t('tracking.locations.loadError')} error={locations.error} onRetry={() => void locations.refetch()} />
  if (!locations.data) return <PageSpinner label={t('tracking.locations.loading')} />

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Checkbox
          label={t('tracking.locations.showArchived')}
          checked={showArchived}
          onChange={(event) => updateParams({ [SHOW_ARCHIVED_PARAM]: event.target.checked ? '1' : null })}
        />
        <div className="self-start sm:self-auto">{addBuilding}</div>
      </div>
      {shown.length === 0 ? (
        <EmptyState icon={Building2} title={buildings.length > 0 ? t('tracking.locations.emptyActive') : t('tracking.locations.empty')} action={addBuilding} />
      ) : (
        <div ref={treeRef} className="grid grid-cols-1 items-start gap-4 xl:grid-cols-2">
          {shown.map((building) => (
            <BuildingCard key={building.id} building={building} showArchived={showArchived} actions={actions} />
          ))}
        </div>
      )}
      {editing && <PlaceDialog target={editing} buildings={buildings} onClose={() => setEditing(null)} />}
      {archiving && <ArchiveDialog key={archiving.place.id} target={archiving} onClose={() => setArchiving(null)} onArchived={() => recoverFocus(archiving.place.id)} />}
    </div>
  )
}
