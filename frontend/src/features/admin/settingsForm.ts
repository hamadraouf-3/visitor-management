import { i18n, isLanguage, type Language } from '../../i18n'
import type { CompanySettings, CompanySettingsUpdate } from '../../types/api'
import { maxLengthMessage, type FormErrors } from '../../utils/forms'

const t = i18n.getFixedT(null, 'admin')

/** Limits of `companies` (§4) and of the settings schema; the server enforces the same. */
export const SETTINGS_LIMITS = { name: 200, nameAr: 200, address: 1000, addressAr: 1000, emailDomain: 253, timezone: 64, graceMinutes: 1440 } as const

/** The settings as the form edits them (numbers as typed text, so a half-typed value is kept). */
export interface SettingsValues {
  name: string
  /** The company's Arabic name ('' = none: the Arabic UI and e-mails then use `name`). */
  nameAr: string
  /** The UI language of users without a preference, and the language visitor e-mails lead with. */
  defaultLanguage: Language
  timezone: string
  address: string
  /** The company's Arabic address ('' = none: the Arabic e-mail section then uses `address`). */
  addressAr: string
  emailDomain: string
  graceBefore: string
  graceAfter: string
  notifyHostOnCheckIn: boolean
  allowWalkIns: boolean
}

export type SettingsField = keyof SettingsValues

/** The form's fields and the request paths the server reports them under (§8.2 `details.fields`). */
export const SETTINGS_FIELDS: Record<SettingsField, string> = {
  name: 'name',
  nameAr: 'name_ar',
  defaultLanguage: 'default_language',
  timezone: 'timezone',
  address: 'address',
  addressAr: 'address_ar',
  emailDomain: 'email_domain',
  graceBefore: 'pass_grace_before_minutes',
  graceAfter: 'pass_grace_after_minutes',
  notifyHostOnCheckIn: 'notify_host_on_check_in',
  allowWalkIns: 'allow_walk_ins',
}

/** The company's default language; an API from before the field (or a mocked one) counts as Arabic, the product's default. */
function defaultLanguageOf(settings: CompanySettings): Language {
  const value: unknown = settings.default_language
  return isLanguage(value) ? value : 'ar'
}

export function settingsValues(settings: CompanySettings): SettingsValues {
  return {
    name: settings.name,
    nameAr: settings.name_ar ?? '',
    defaultLanguage: defaultLanguageOf(settings),
    timezone: settings.timezone,
    address: settings.address ?? '',
    addressAr: settings.address_ar ?? '',
    emailDomain: settings.email_domain ?? '',
    graceBefore: String(settings.pass_grace_before_minutes),
    graceAfter: String(settings.pass_grace_after_minutes),
    notifyHostOnCheckIn: settings.notify_host_on_check_in,
    allowWalkIns: settings.allow_walk_ins,
  }
}

/** A whole number of minutes from 0 to 1440, or null. Only plain digits count ("1e2", "-0", "60.0" do not). */
export function parseGraceMinutes(text: string): number | null {
  const value = text.trim()
  if (!/^\d{1,4}$/.test(value)) return null
  const minutes = Number(value)
  return minutes <= SETTINGS_LIMITS.graceMinutes ? minutes : null
}

/**
 * The email domain as the server stores it: lowercase, without a leading "@" (the server's
 * `normalise_domain_name`). Empty text means none.
 */
export function normaliseEmailDomain(text: string): string {
  return text.trim().toLowerCase().replace(/^@+/, '')
}

// Labels of letters, digits and inner hyphens; a top-level label of at least two characters
// starting with a letter (so IDN "xn--" top-level domains pass); at most 253 characters in all.
// The server's rule (`normalise_domain_name`, B1-54).
const DOMAIN_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])$/

/** Text with a line break, tab or other control character (the server refuses them in names: one line). */
// oxlint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/

export function validateSettings(values: SettingsValues): FormErrors<SettingsField> {
  const errors: FormErrors<SettingsField> = {}
  const graceMessage = t('settings.validation.grace')
  const name = values.name.trim()
  if (!name) errors.name = t('settings.validation.nameRequired')
  else if (name.length > SETTINGS_LIMITS.name) errors.name = maxLengthMessage(SETTINGS_LIMITS.name)

  // Optional, with the rules of the name (B10-2): at most 200 characters, one line.
  const nameAr = values.nameAr.trim()
  if (nameAr.length > SETTINGS_LIMITS.nameAr) errors.nameAr = maxLengthMessage(SETTINGS_LIMITS.nameAr)
  else if (CONTROL_CHARACTERS.test(nameAr)) errors.nameAr = t('settings.validation.oneLine')

  if (!values.timezone.trim()) errors.timezone = t('settings.validation.timezoneRequired')
  else if (values.timezone.trim().length > SETTINGS_LIMITS.timezone) errors.timezone = t('settings.validation.timezoneFromList')

  if (values.address.trim().length > SETTINGS_LIMITS.address) errors.address = maxLengthMessage(SETTINGS_LIMITS.address)
  // Optional, with the rules of the address (phase 10 shared contract B).
  if (values.addressAr.trim().length > SETTINGS_LIMITS.addressAr) errors.addressAr = maxLengthMessage(SETTINGS_LIMITS.addressAr)

  const domain = normaliseEmailDomain(values.emailDomain)
  if (domain.length > SETTINGS_LIMITS.emailDomain) errors.emailDomain = maxLengthMessage(SETTINGS_LIMITS.emailDomain)
  else if (domain && !DOMAIN_PATTERN.test(domain)) errors.emailDomain = t('settings.validation.domain', { example: 'example.com' })

  if (parseGraceMinutes(values.graceBefore) === null) errors.graceBefore = graceMessage
  if (parseGraceMinutes(values.graceAfter) === null) errors.graceAfter = graceMessage
  return errors
}

/**
 * PATCH /company/settings body with only what changed, or null when nothing did (call after
 * `validateSettings` passed). A cleared Arabic name, address, Arabic address or email domain is sent as `null`.
 */
export function toSettingsUpdate(settings: CompanySettings, values: SettingsValues): CompanySettingsUpdate | null {
  const body: CompanySettingsUpdate = {}
  const name = values.name.trim()
  if (name !== settings.name) body.name = name
  const nameAr = values.nameAr.trim()
  if (nameAr !== (settings.name_ar ?? '')) body.name_ar = nameAr || null
  if (values.defaultLanguage !== defaultLanguageOf(settings)) body.default_language = values.defaultLanguage
  const timezone = values.timezone.trim()
  if (timezone !== settings.timezone) body.timezone = timezone
  const address = values.address.trim()
  if (address !== (settings.address ?? '')) body.address = address || null
  const addressAr = values.addressAr.trim()
  // `?? ''`: an API from before the field (or a mocked one) leaves it out.
  if (addressAr !== (settings.address_ar ?? '')) body.address_ar = addressAr || null
  const domain = normaliseEmailDomain(values.emailDomain)
  if (domain !== (settings.email_domain ?? '')) body.email_domain = domain || null
  const before = parseGraceMinutes(values.graceBefore)
  if (before !== null && before !== settings.pass_grace_before_minutes) body.pass_grace_before_minutes = before
  const after = parseGraceMinutes(values.graceAfter)
  if (after !== null && after !== settings.pass_grace_after_minutes) body.pass_grace_after_minutes = after
  if (values.notifyHostOnCheckIn !== settings.notify_host_on_check_in) body.notify_host_on_check_in = values.notifyHostOnCheckIn
  if (values.allowWalkIns !== settings.allow_walk_ins) body.allow_walk_ins = values.allowWalkIns
  return Object.keys(body).length > 0 ? body : null
}

/**
 * Whether the form differs from the saved settings, as a person would judge it: surrounding
 * spaces, the case of the domain and an unfinished number count as changes only when they
 * change what would be saved, but any edit to a number field that is not a valid number does.
 */
export function settingsDirty(settings: CompanySettings, values: SettingsValues): boolean {
  if (toSettingsUpdate(settings, values) !== null) return true
  return (
    values.graceBefore.trim() !== String(settings.pass_grace_before_minutes) ||
    values.graceAfter.trim() !== String(settings.pass_grace_after_minutes)
  )
}

/** "60 minutes (1 hour)", "90 minutes (1 hour 30 min)", "0 minutes": the grace hint under each field. */
export function describeGraceMinutes(text: string): string | null {
  const minutes = parseGraceMinutes(text)
  if (minutes === null) return null
  if (minutes < 60) return t('settings.grace.minutes', { count: minutes })
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  const hoursText = t('settings.grace.hours', { count: hours })
  return rest === 0
    ? t('settings.grace.withHours', { minutes, hours: hoursText })
    : t('settings.grace.withHoursAndMinutes', { minutes, hours: hoursText, rest })
}
