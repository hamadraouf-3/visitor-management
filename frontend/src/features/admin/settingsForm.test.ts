import { describe, expect, it } from 'vitest'
import type { CompanySettings } from '../../types/api'
import {
  describeGraceMinutes,
  normaliseEmailDomain,
  parseGraceMinutes,
  settingsDirty,
  settingsValues,
  toSettingsUpdate,
  validateSettings,
} from './settingsForm'
import { filterTimeZones, listTimeZones, timeZoneLabel } from './timeZones'

const settings: CompanySettings = {
  id: 'c-1',
  name: 'Acme Holdings',
  name_ar: null,
  default_language: 'en',
  timezone: 'Asia/Amman',
  address: null,
  address_ar: null,
  email_domain: 'acme.example',
  pass_grace_before_minutes: 60,
  pass_grace_after_minutes: 60,
  notify_host_on_check_in: true,
  allow_walk_ins: true,
}

describe('parseGraceMinutes', () => {
  it('accepts whole minutes from 0 to 1440 only', () => {
    expect(parseGraceMinutes('0')).toBe(0)
    expect(parseGraceMinutes(' 1440 ')).toBe(1440)
    for (const text of ['1441', '-1', '1.5', '1e2', '', 'abc', '60.0']) expect(parseGraceMinutes(text)).toBeNull()
  })

  it('describes the duration', () => {
    expect(describeGraceMinutes('45')).toBe('45 minutes')
    expect(describeGraceMinutes('60')).toBe('60 minutes (1 hour)')
    expect(describeGraceMinutes('150')).toBe('150 minutes (2 hours 30 min)')
    expect(describeGraceMinutes('x')).toBeNull()
  })
})

describe('validateSettings', () => {
  it('accepts the saved settings', () => {
    expect(Object.values(validateSettings(settingsValues(settings))).filter(Boolean)).toEqual([])
  })

  it('reports every invalid field', () => {
    const errors = validateSettings({
      ...settingsValues(settings),
      name: ' ',
      timezone: '',
      emailDomain: 'person@acme.example',
      graceBefore: '1500',
      graceAfter: '',
    })
    expect(errors).toEqual({
      name: 'Enter the company name.',
      timezone: 'Choose a time zone.',
      emailDomain: 'Enter a domain such as example.com, without a name or "@".',
      graceBefore: 'Enter whole minutes from 0 to 1440 (24 hours).',
      graceAfter: 'Enter whole minutes from 0 to 1440 (24 hours).',
    })
  })

  it('accepts domains as the server does', () => {
    for (const domain of ['@Acme.Example', 'sub.acme.co', 'fail.test', 'example.xn--p1ai', '']) {
      expect(validateSettings({ ...settingsValues(settings), emailDomain: domain }).emailDomain).toBeUndefined()
    }
    for (const domain of ['acme', 'acme.c', '-acme.com', 'acme.123', 'a b.com']) {
      expect(validateSettings({ ...settingsValues(settings), emailDomain: domain }).emailDomain).toBeDefined()
    }
    expect(normaliseEmailDomain(' @@Acme.Example ')).toBe('acme.example')
  })
})

describe('toSettingsUpdate', () => {
  it('sends only what changed, normalised', () => {
    expect(toSettingsUpdate(settings, settingsValues(settings))).toBeNull()
    expect(
      toSettingsUpdate(settings, {
        ...settingsValues(settings),
        name: ' Acme Group ',
        emailDomain: '@ACME.EXAMPLE',
        graceBefore: '030',
        allowWalkIns: false,
      }),
    ).toEqual({ name: 'Acme Group', pass_grace_before_minutes: 30, allow_walk_ins: false })
  })

  it('clears the address and the email domain with null', () => {
    const withAddress = { ...settings, address: '1 Main St' }
    expect(toSettingsUpdate(withAddress, { ...settingsValues(withAddress), address: '  ', emailDomain: '' })).toEqual({
      address: null,
      email_domain: null,
    })
  })
})

describe('settingsDirty', () => {
  it('counts an edit of a number field even before it is a valid number', () => {
    expect(settingsDirty(settings, settingsValues(settings))).toBe(false)
    expect(settingsDirty(settings, { ...settingsValues(settings), graceAfter: '' })).toBe(true)
    expect(settingsDirty(settings, { ...settingsValues(settings), name: 'Acme Holdings ' })).toBe(false)
    expect(settingsDirty(settings, { ...settingsValues(settings), notifyHostOnCheckIn: false })).toBe(true)
  })
})

describe('time zones', () => {
  it('lists the browser’s zones plus UTC and the current one, sorted', () => {
    expect(listTimeZones('Etc/GMT-3', ['Europe/Paris', 'Asia/Amman'])).toEqual(['Asia/Amman', 'Etc/GMT-3', 'Europe/Paris', 'UTC'])
  })

  it('falls back to a fixed list without Intl.supportedValuesOf', () => {
    const zones = listTimeZones(null, null)
    expect(zones).toContain('Asia/Amman')
    expect(zones).toContain('America/New_York')
  })

  it('uses Intl.supportedValuesOf when the browser has it', () => {
    expect(listTimeZones().length).toBeGreaterThan(300)
  })

  it('finds zones by city, ignoring case and underscores', () => {
    const zones = ['America/New_York', 'Asia/Amman', 'Europe/Zürich']
    expect(filterTimeZones(zones, 'new york')).toEqual(['America/New_York'])
    expect(filterTimeZones(zones, 'AMMAN')).toEqual(['Asia/Amman'])
    expect(filterTimeZones(zones, 'zurich')).toEqual(['Europe/Zürich'])
    expect(filterTimeZones(zones, ' ')).toEqual(zones)
  })

  it('reads a zone by its place, keeping the IANA name', () => {
    const july = Date.parse('2026-07-01T12:00:00Z')
    expect(timeZoneLabel('America/Los_Angeles', july)).toBe('Los Angeles — America/Los_Angeles (UTC-7)')
    expect(timeZoneLabel('Asia/Kolkata', july)).toBe('Kolkata — Asia/Kolkata (UTC+5:30)')
    expect(timeZoneLabel('Etc/GMT+5', july)).toBe('Etc/GMT+5 (UTC-5)')
    expect(timeZoneLabel('UTC', july)).toBe('UTC')
  })
})
