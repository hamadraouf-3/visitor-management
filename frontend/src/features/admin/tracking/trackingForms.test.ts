import { describe, expect, it } from 'vitest'
import { makeCamera, makeTrackingSettings } from '../../journey/testRoutes'
import type { BuildingNode } from '../../journey/types'
import {
  activeZoneGroups,
  ALERT_EMAIL_PATHS,
  alertEmailsDirty,
  cameraValues,
  confidenceText,
  parseLevel,
  parsePercent,
  parseWhole,
  thresholdsDirty,
  thresholdValues,
  toAlertEmailsUpdate,
  toThresholdUpdate,
  validateAlertEmail,
  validateCamera,
  validateKeyLabel,
  validatePlace,
  validateThresholds,
  withAlertEmail,
} from './trackingForms'

describe('the thresholds', () => {
  it('shows the confidence as a percentage, and none as empty', () => {
    expect(confidenceText(0.85)).toBe('85')
    expect(confidenceText(0.875)).toBe('87.5')
    expect(confidenceText(null)).toBe('')
    expect(thresholdValues(makeTrackingSettings({ min_confidence: null }))).toEqual({ minConfidence: '', staleMinutes: '15', retentionDays: '30' })
  })

  it('reads percentages and whole numbers in either digits, within their bounds', () => {
    expect(parsePercent('87.5')).toBe(87.5)
    expect(parsePercent('٨٧٫٥')).toBe(87.5)
    expect(parsePercent('87,5')).toBe(87.5)
    expect(parsePercent('101')).toBeNull()
    expect(parsePercent('-1')).toBeNull()
    expect(parsePercent('0.001')).toBeNull()
    // Below 1 %: almost always a share typed for a percentage (0.8 for 80 %), refused.
    expect(parsePercent('0.8')).toBeNull()
    expect(parsePercent('0')).toBeNull()
    expect(parsePercent('1')).toBe(1)
    expect(parsePercent('100')).toBe(100)
    expect(parseWhole('١٥', { min: 1, max: 240 })).toBe(15)
    expect(parseWhole('0', { min: 1, max: 240 })).toBeNull()
    expect(parseWhole('241', { min: 1, max: 240 })).toBeNull()
    expect(parseWhole('1.5', { min: 1, max: 240 })).toBeNull()
  })

  it('validates each field at its own place', () => {
    expect(validateThresholds({ minConfidence: '', staleMinutes: '15', retentionDays: '30' })).toEqual({})
    expect(validateThresholds({ minConfidence: '120', staleMinutes: '0', retentionDays: '91' })).toEqual({
      minConfidence: 'Enter a percentage from 1 to 100.',
      staleMinutes: 'Enter a whole number from 1 to 240.',
      retentionDays: 'Enter a whole number from 1 to 90.',
    })
  })

  it('sends only what changed, the confidence as a share, and null to clear it', () => {
    const settings = makeTrackingSettings({ min_confidence: 0.8 })
    expect(toThresholdUpdate(settings, { minConfidence: '80', staleMinutes: '15', retentionDays: '30' })).toBeNull()
    expect(toThresholdUpdate(settings, { minConfidence: '87.5', staleMinutes: '20', retentionDays: '30' })).toEqual({ min_confidence: 0.875, stale_after_minutes: 20 })
    expect(toThresholdUpdate(settings, { minConfidence: ' ', staleMinutes: '15', retentionDays: '7' })).toEqual({ min_confidence: null, retention_days: 7 })
    expect(thresholdsDirty(settings, { minConfidence: '80 ', staleMinutes: '15', retentionDays: '30' })).toBe(false)
    expect(thresholdsDirty(settings, { minConfidence: '', staleMinutes: '15', retentionDays: '30' })).toBe(true)
  })
})

describe('a place', () => {
  const buildings = [{ id: 'b1', name: 'North Tower' }, { id: 'b2', name: 'Annex' }]

  it('needs a name, unique among its siblings in any case, of at most 120 characters', () => {
    expect(validatePlace('building', { name: ' ', nameAr: '', level: '', access: 'STANDARD' }, { names: buildings })).toEqual({ name: 'Enter a name.' })
    expect(validatePlace('building', { name: 'north tower', nameAr: '', level: '', access: 'STANDARD' }, { names: buildings })).toEqual({ name: 'This name is already used here.' })
    expect(validatePlace('building', { name: 'North Tower', nameAr: 'البرج', level: '', access: 'STANDARD' }, { names: buildings }, 'b1')).toEqual({})
    expect(validatePlace('zone', { name: 'x'.repeat(121), nameAr: 'ع'.repeat(121), level: '', access: 'STANDARD' }, { names: [] })).toEqual({
      name: 'Enter at most 120 characters.',
      nameAr: 'Enter at most 120 characters.',
    })
  })

  it('needs a floor’s level, a whole number from −20 to 200, unique in its building', () => {
    const floors = { names: [{ id: 'f1', name: 'Ground' }], levels: [{ id: 'f1', level: 0 }] }
    expect(validatePlace('floor', { name: 'Ground', nameAr: '', level: '0', access: 'STANDARD' }, floors)).toEqual({ level: 'This building already has a floor at this level.' })
    expect(validatePlace('floor', { name: 'Basement', nameAr: '', level: '−2', access: 'STANDARD' }, floors)).toEqual({})
    expect(validatePlace('floor', { name: 'Roof', nameAr: '', level: '201', access: 'STANDARD' }, floors)).toEqual({ level: 'Enter a whole number from -20 to 200.' })
    expect(parseLevel('-٣')).toBe(-3)
    expect(parseLevel('2.5')).toBeNull()
  })
})

const zone = (id: string, isActive = true) => ({ id, floor_id: 'f', name: id, name_ar: null, access: 'STANDARD' as const, is_active: isActive, created_at: '', updated_at: '' })
const floor = (id: string, zones: ReturnType<typeof zone>[], isActive = true) => ({ id, building_id: 'b', name: id, name_ar: null, level: 1, is_active: isActive, created_at: '', updated_at: '', zones })

describe('a camera', () => {
  it('needs the provider’s ID (visible characters, no space, unique), a name and a zone', () => {
    expect(validateCamera(cameraValues(), [])).toEqual({ providerCameraId: 'Enter the provider’s camera ID.', name: 'Enter a name.', zoneId: 'Choose a zone.' })
    expect(validateCamera({ providerCameraId: 'cam 01', name: 'Gate', zoneId: 'z', isEnrollmentPoint: false }, [])).toEqual({ providerCameraId: 'Use Latin letters, digits and symbols, without spaces.' })
    expect(validateCamera({ providerCameraId: 'كاميرا', name: 'Gate', zoneId: 'z', isEnrollmentPoint: false }, [])).toEqual({ providerCameraId: 'Use Latin letters, digits and symbols, without spaces.' })
    const camera = makeCamera()
    expect(validateCamera({ providerCameraId: camera.provider_camera_id, name: 'Gate', zoneId: 'z', isEnrollmentPoint: false }, [camera])).toEqual({ providerCameraId: 'A camera with this ID already exists.' })
    expect(validateCamera(cameraValues(camera), [camera], camera.id)).toEqual({})
  })

  it('is put in an active zone, offered by building and floor', () => {
    const buildings: BuildingNode[] = [
      { id: 'b1', name: 'A', name_ar: null, is_active: true, created_at: '', updated_at: '', floors: [floor('f1', [zone('z1'), zone('z2', false)]), floor('f2', [zone('z3')], false), floor('f3', [])] },
      { id: 'b2', name: 'B', name_ar: null, is_active: false, created_at: '', updated_at: '', floors: [floor('f4', [zone('z4')])] },
    ]
    expect(activeZoneGroups(buildings).map((group) => [group.floor.id, group.zones.map((one) => one.id)])).toEqual([['f1', ['z1']]])
  })
})

describe('a key’s label', () => {
  it('is required, one line, at most 100 characters', () => {
    expect(validateKeyLabel(' ')).toBe('Enter a label.')
    expect(validateKeyLabel('a\nb')).toBe('Write the label on one line.')
    expect(validateKeyLabel('x'.repeat(101))).toBe('Enter at most 100 characters.')
    expect(validateKeyLabel('Shaheen pilot')).toBeUndefined()
  })
})

describe('the alert e-mails (Phase 16)', () => {
  const listed = ['ops@example.com', 'security@example.com']

  it('takes a valid address not listed yet, five at most, lower case as the server keeps it', () => {
    expect(validateAlertEmail(' ', listed)).toBe('Enter an email address.')
    expect(validateAlertEmail('ops at example', listed)).toBe('Enter a valid email address, like name@company.com.')
    expect(validateAlertEmail(' Ops@Example.COM ', listed)).toBe('This address is already listed.')
    expect(validateAlertEmail('desk@example.com', ['a@x.io', 'b@x.io', 'c@x.io', 'd@x.io', 'e@x.io'])).toBe('Enter at most 5 addresses.')
    expect(validateAlertEmail(`${'a'.repeat(250)}@x.io`, listed)).toBe('Enter at most 254 characters.')
    expect(validateAlertEmail('Desk@Example.com', listed)).toBeUndefined()
    expect(withAlertEmail(listed, ' Desk@Example.com ')).toEqual([...listed, 'desk@example.com'])
  })

  it('sends the list only when it changed, in its order', () => {
    const settings = makeTrackingSettings({ alert_emails: listed })
    expect(alertEmailsDirty(settings, null)).toBe(false)
    expect(toAlertEmailsUpdate(settings, null)).toBeNull()
    expect(toAlertEmailsUpdate(settings, [...listed])).toBeNull()
    expect(alertEmailsDirty(settings, listed.toReversed())).toBe(true)
    expect(toAlertEmailsUpdate(settings, ['ops@example.com'])).toEqual({ alert_emails: ['ops@example.com'] })
    expect(toAlertEmailsUpdate(settings, [])).toEqual({ alert_emails: [] })
  })

  it('finds the server’s refusal on the list or on one of its places', () => {
    expect(ALERT_EMAIL_PATHS).toEqual(['alert_emails', 'alert_emails.0', 'alert_emails.1', 'alert_emails.2', 'alert_emails.3', 'alert_emails.4'])
  })
})
