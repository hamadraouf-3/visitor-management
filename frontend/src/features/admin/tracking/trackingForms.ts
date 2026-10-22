import { i18n } from '../../../i18n'
import type { TrackingCamera, TrackingSettings, TrackingSettingsUpdate, ZoneAccess } from '../../../types/api'
import { maxLengthMessage, type FormErrors, type ServerFieldPaths } from '../../../utils/forms'
import type { BuildingNode, FloorNode } from '../../journey/types'

/*
 * The pure logic of the tracking administration's forms (Phase 15): the thresholds, a place's names (and a
 * floor's level, a zone's access level since Phase 16), a camera, a key's label, and the alert e-mails
 * (Phase 16). Each mirrors the server's rules (phase15-api-shapes, the Phase 16 contract), which have the
 * final word: these only spare a request and say the problem at its field.
 */

const t = i18n.getFixedT(null, 'admin')

/* Thresholds ----------------------------------------------------------------------------------- */

export const STALE_MINUTES = { min: 1, max: 240 } as const
export const RETENTION_DAYS = { min: 1, max: 90 } as const

export interface ThresholdValues {
  /** A percentage, 1–100, as typed; '' = none (no observation counts as confirmed). */
  minConfidence: string
  staleMinutes: string
  retentionDays: string
}

export type ThresholdField = keyof ThresholdValues

export const THRESHOLD_FIELDS: ServerFieldPaths<ThresholdField> = {
  minConfidence: 'min_confidence',
  staleMinutes: 'stale_after_minutes',
  retentionDays: 'retention_days',
}

/** The share as a percentage with at most two decimals: 0.85 → "85", 0.875 → "87.5". */
export function confidenceText(value: number | null): string {
  return value === null ? '' : String(Math.round(value * 10_000) / 100)
}

export function thresholdValues(settings: TrackingSettings): ThresholdValues {
  return {
    minConfidence: confidenceText(settings.min_confidence),
    staleMinutes: String(settings.stale_after_minutes),
    retentionDays: String(settings.retention_days),
  }
}

/**
 * A percentage from 1 to 100 typed with a point or a comma (and the Arabic digits a phone may type); null for
 * anything else. Below 1 is refused: "0.8" is almost always a share typed for 80 %, which would store 0.008
 * and confirm nearly everything (F15-34).
 */
export function parsePercent(text: string): number | null {
  const western = text.trim().replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660)).replace(/[٫,]/, '.')
  if (!/^\d{1,3}(?:\.\d{1,2})?$/.test(western)) return null
  const value = Number(western)
  return value >= 1 && value <= 100 ? value : null
}

/** A whole number within the bounds, typed in either digits; null for anything else. */
export function parseWhole(text: string, { min, max }: { min: number; max: number }): number | null {
  const western = text.trim().replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660))
  if (!/^\d{1,4}$/.test(western)) return null
  const value = Number(western)
  return value >= min && value <= max ? value : null
}

export function validateThresholds(values: ThresholdValues): FormErrors<ThresholdField> {
  const errors: FormErrors<ThresholdField> = {}
  if (values.minConfidence.trim() !== '' && parsePercent(values.minConfidence) === null) errors.minConfidence = t('tracking.settings.validation.confidence')
  if (parseWhole(values.staleMinutes, STALE_MINUTES) === null) errors.staleMinutes = t('tracking.settings.validation.range', STALE_MINUTES)
  if (parseWhole(values.retentionDays, RETENTION_DAYS) === null) errors.retentionDays = t('tracking.settings.validation.range', RETENTION_DAYS)
  return errors
}

/** The share the server stores for a typed percentage: 87.5 → 0.875 (four decimals at most). */
function shareOf(text: string): number | null {
  if (text.trim() === '') return null
  const percent = parsePercent(text)
  return percent === null ? null : Math.round(percent * 100) / 10_000
}

/** Only what changed from the settings the form was opened with; null when nothing did. Call after `validateThresholds`. */
export function toThresholdUpdate(settings: TrackingSettings, values: ThresholdValues): TrackingSettingsUpdate | null {
  const body: TrackingSettingsUpdate = {}
  const confidence = shareOf(values.minConfidence)
  if (confidence !== settings.min_confidence) body.min_confidence = confidence
  const stale = parseWhole(values.staleMinutes, STALE_MINUTES)
  if (stale !== null && stale !== settings.stale_after_minutes) body.stale_after_minutes = stale
  const retention = parseWhole(values.retentionDays, RETENTION_DAYS)
  if (retention !== null && retention !== settings.retention_days) body.retention_days = retention
  return Object.keys(body).length > 0 ? body : null
}

export function thresholdsDirty(settings: TrackingSettings, values: ThresholdValues): boolean {
  const opened = thresholdValues(settings)
  return (Object.keys(opened) as ThresholdField[]).some((field) => opened[field].trim() !== values[field].trim())
}

/* A place: a building, a floor or a zone --------------------------------------------------------- */

/** The names' limit (the department name rules); the server enforces the same and trims. */
export const LOCATION_NAME_MAX = 120
export const FLOOR_LEVEL = { min: -20, max: 200 } as const

export type PlaceKind = 'building' | 'floor' | 'zone'

export interface PlaceValues {
  name: string
  /** '' = no Arabic name. */
  nameAr: string
  /** A floor's level, as typed (floors only). */
  level: string
  /** A zone's access level (zones only, Phase 16): standard unless chosen. */
  access: ZoneAccess
}

export type PlaceField = keyof PlaceValues

export const PLACE_FIELDS: ServerFieldPaths<PlaceField> = { name: 'name', nameAr: 'name_ar', level: 'level', access: 'access' }

/** A whole level typed with an optional minus (also «−» and Arabic digits); null for anything else. */
export function parseLevel(text: string): number | null {
  const western = text
    .trim()
    .replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660))
    .replace(/^[−‐-]/, '-')
  if (!/^-?\d{1,3}$/.test(western)) return null
  const value = Number(western)
  return value >= FLOOR_LEVEL.min && value <= FLOOR_LEVEL.max ? value : null
}

const sameText = (stored: string | null | undefined, wanted: string) => typeof stored === 'string' && wanted !== '' && stored.trim().toLowerCase() === wanted.trim().toLowerCase()

export interface PlaceSiblings {
  /** The other places under the same parent (a building's for a building: every building of the company). */
  names: readonly { id: string; name: string }[]
  /** A floor's sibling floors, for its level. */
  levels?: readonly { id: string; level: number }[]
}

/**
 * A place's name is required (one line, at most 120 characters), its Arabic name optional; a building's
 * name is unique in the company, a zone's in its floor (any case), a floor's level in its building. `id` is
 * the place being edited (its own name and level are not duplicates).
 */
export function validatePlace(kind: PlaceKind, values: PlaceValues, siblings: PlaceSiblings, id?: string): FormErrors<PlaceField> {
  const errors: FormErrors<PlaceField> = {}
  const name = values.name.trim()
  if (!name) errors.name = t('tracking.locations.validation.nameRequired')
  else if (name.length > LOCATION_NAME_MAX) errors.name = maxLengthMessage(LOCATION_NAME_MAX)
  else if (kind !== 'floor' && siblings.names.some((other) => other.id !== id && sameText(other.name, name))) errors.name = t('tracking.locations.validation.duplicate')
  if (values.nameAr.trim().length > LOCATION_NAME_MAX) errors.nameAr = maxLengthMessage(LOCATION_NAME_MAX)
  if (kind === 'floor') {
    const level = parseLevel(values.level)
    if (level === null) errors.level = t('tracking.locations.validation.level', FLOOR_LEVEL)
    else if (siblings.levels?.some((other) => other.id !== id && other.level === level)) errors.level = t('tracking.locations.validation.levelTaken')
  }
  return errors
}

/* A camera ---------------------------------------------------------------------------------------- */

export const CAMERA_ID_MAX = 128
export const CAMERA_NAME_MAX = 120

export interface CameraValues {
  providerCameraId: string
  name: string
  zoneId: string
  isEnrollmentPoint: boolean
}

export type CameraField = 'providerCameraId' | 'name' | 'zoneId'

export const CAMERA_FIELDS: ServerFieldPaths<CameraField> = { providerCameraId: 'provider_camera_id', name: 'name', zoneId: 'zone_id' }

export function cameraValues(camera?: TrackingCamera): CameraValues {
  return {
    providerCameraId: camera?.provider_camera_id ?? '',
    name: camera?.name ?? '',
    zoneId: camera?.zone_id ?? '',
    isEnrollmentPoint: camera?.is_enrollment_point ?? false,
  }
}

/** The provider's camera ID: visible ASCII characters (no space), 1–128. */
const PROVIDER_CAMERA_ID = /^[\x21-\x7e]+$/

export function validateCamera(values: CameraValues, cameras: readonly TrackingCamera[], id?: string): FormErrors<CameraField> {
  const errors: FormErrors<CameraField> = {}
  const providerId = values.providerCameraId.trim()
  if (!providerId) errors.providerCameraId = t('tracking.cameras.validation.idRequired')
  else if (providerId.length > CAMERA_ID_MAX) errors.providerCameraId = maxLengthMessage(CAMERA_ID_MAX)
  else if (!PROVIDER_CAMERA_ID.test(providerId)) errors.providerCameraId = t('tracking.cameras.validation.idFormat')
  else if (cameras.some((camera) => camera.id !== id && camera.provider_camera_id === providerId)) errors.providerCameraId = t('tracking.cameras.validation.idTaken')
  const name = values.name.trim()
  if (!name) errors.name = t('tracking.cameras.validation.nameRequired')
  else if (name.length > CAMERA_NAME_MAX) errors.name = maxLengthMessage(CAMERA_NAME_MAX)
  if (!values.zoneId) errors.zoneId = t('tracking.cameras.validation.zoneRequired')
  return errors
}

/** The active zones a camera can be put in, by building and floor, in the tree's order. */
export function activeZoneGroups(buildings: readonly BuildingNode[]): { building: BuildingNode; floor: FloorNode; zones: FloorNode['zones'] }[] {
  return buildings
    .filter((building) => building.is_active)
    .flatMap((building) =>
      building.floors
        .filter((floor) => floor.is_active)
        .map((floor) => ({ building, floor, zones: floor.zones.filter((zone) => zone.is_active) }))
        .filter((group) => group.zones.length > 0),
    )
}

/* A key ------------------------------------------------------------------------------------------- */

export const KEY_LABEL_MAX = 100

export function validateKeyLabel(label: string): string | undefined {
  const text = label.trim()
  if (!text) return t('tracking.keys.validation.labelRequired')
  if (text.length > KEY_LABEL_MAX) return maxLengthMessage(KEY_LABEL_MAX)
  if (/[\r\n]/.test(text)) return t('tracking.keys.validation.oneLine')
  return undefined
}

/* The alert e-mails (Phase 16) -------------------------------------------------------------------- */

/** The server's limit of the list, and of an address. */
export const MAX_ALERT_EMAILS = 5
export const ALERT_EMAIL_MAX = 254

// Deliberately permissive, as the other address checks (B1-22): the server validates addresses.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** An address as the server keeps it: trimmed, lower case. */
export function normaliseAlertEmail(text: string): string {
  return text.trim().toLowerCase()
}

/** What is wrong with an address to add to the list, or undefined: required, a valid address, not listed yet, five at most. */
export function validateAlertEmail(text: string, list: readonly string[]): string | undefined {
  const email = normaliseAlertEmail(text)
  if (!email) return t('tracking.alerts.validation.emailRequired')
  if (email.length > ALERT_EMAIL_MAX) return maxLengthMessage(ALERT_EMAIL_MAX)
  if (!EMAIL_PATTERN.test(email)) return i18n.t('validation.emailInvalid', { ns: 'auth', example: 'name@company.com' })
  if (list.includes(email)) return t('tracking.alerts.validation.emailListed')
  if (list.length >= MAX_ALERT_EMAILS) return t('tracking.alerts.validation.emailsFull', { max: MAX_ALERT_EMAILS })
  return undefined
}

/** The list with the address added (normalised) at its end. Call after `validateAlertEmail` passed. */
export function withAlertEmail(list: readonly string[], text: string): string[] {
  return [...list, normaliseAlertEmail(text)]
}

/** The same addresses, in the same order, as the settings have. */
export function alertEmailsDirty(settings: Pick<TrackingSettings, 'alert_emails'>, draft: readonly string[] | null): boolean {
  if (draft === null) return false
  return draft.length !== settings.alert_emails.length || draft.some((email, index) => email !== settings.alert_emails[index])
}

/** The change to send, or null when the list is the settings' own. */
export function toAlertEmailsUpdate(settings: Pick<TrackingSettings, 'alert_emails'>, draft: readonly string[] | null): TrackingSettingsUpdate | null {
  return draft !== null && alertEmailsDirty(settings, draft) ? { alert_emails: [...draft] } : null
}

/** Where the server reports a refused address: the list, or one of its five places (`alert_emails.2`). */
export const ALERT_EMAIL_PATHS: readonly string[] = ['alert_emails', ...Array.from({ length: MAX_ALERT_EMAILS }, (_, index) => `alert_emails.${index}`)]
