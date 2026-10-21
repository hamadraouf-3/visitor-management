import { describe, expect, it } from 'vitest'
import contract from '../types/backend-contract.json'
import type { ApiErrorCode } from '../types/api'
import { NAMESPACES, resources } from './resources'

/** Arabic needs all six plural categories (zero, one, two, few, many, other). */
const ARABIC_PLURALS = new Intl.PluralRules('ar').resolvedOptions().pluralCategories
const ENGLISH_PLURALS = new Intl.PluralRules('en').resolvedOptions().pluralCategories
const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/

type Catalog = { readonly [key: string]: string | Catalog }

/** "nav.items.reception" → text, for every leaf of a catalog. */
function flatten(catalog: Catalog, prefix = ''): Map<string, string> {
  const entries = new Map<string, string>()
  for (const [key, value] of Object.entries(catalog)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (typeof value === 'string') entries.set(path, value)
    else for (const [nested, text] of flatten(value, path)) entries.set(nested, text)
  }
  return entries
}

/** Keys without their plural suffix, with the plural forms each one has. */
function groupPlurals(keys: Iterable<string>): Map<string, Set<string>> {
  const groups = new Map<string, Set<string>>()
  for (const key of keys) {
    const match = PLURAL_SUFFIX.exec(key)
    const base = match ? key.slice(0, match.index) : key
    const forms = groups.get(base) ?? new Set<string>()
    if (match) forms.add(match[1]!)
    groups.set(base, forms)
  }
  return groups
}

function variables(text: string): string[] {
  return [...text.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((match) => match[1]!).toSorted()
}

describe('translation catalogs', () => {
  it('have every namespace in both languages', () => {
    expect(Object.keys(resources.en).toSorted()).toEqual([...NAMESPACES].toSorted())
    expect(Object.keys(resources.ar).toSorted()).toEqual([...NAMESPACES].toSorted())
  })

  it.each(NAMESPACES)('%s: Arabic has exactly the English keys, with all its plural forms, and no empty text', (namespace) => {
    const english = flatten(resources.en[namespace] as Catalog)
    const arabic = flatten(resources.ar[namespace] as Catalog)
    const englishGroups = groupPlurals(english.keys())
    const arabicGroups = groupPlurals(arabic.keys())

    const problems: string[] = []
    for (const [base, forms] of englishGroups) {
      const arabicForms = arabicGroups.get(base)
      if (!arabicForms) {
        problems.push(`missing in ar: ${base}`)
        continue
      }
      if (forms.size === 0 && arabicForms.size > 0) problems.push(`ar has plural forms, en does not: ${base}`)
      if (forms.size > 0) {
        for (const category of ENGLISH_PLURALS) if (!forms.has(category)) problems.push(`en lacks ${base}_${category}`)
        for (const category of ARABIC_PLURALS) if (!arabicForms.has(category)) problems.push(`ar lacks ${base}_${category}`)
      }
    }
    for (const base of arabicGroups.keys()) if (!englishGroups.has(base)) problems.push(`only in ar (stale?): ${base}`)
    for (const [key, text] of [...english, ...arabic]) if (text.trim() === '') problems.push(`empty text: ${key}`)
    expect(problems).toEqual([])
  })

  it.each(NAMESPACES)('%s: every Arabic text uses the variables of its English text', (namespace) => {
    const english = flatten(resources.en[namespace] as Catalog)
    const arabic = flatten(resources.ar[namespace] as Catalog)
    const problems: string[] = []
    for (const [key, text] of arabic) {
      const match = PLURAL_SUFFIX.exec(key)
      const base = match ? key.slice(0, match.index) : key
      const source = english.get(key) ?? english.get(`${base}_other`)
      if (source === undefined) continue
      // A plural form may say its number in words ("حرفين", two characters) instead of {{count}}
      // or of {{formatted}}, the same count with digit grouping ("1,284", formatCount).
      const numberWords = (name: string) => match !== null && (name === 'count' || name === 'formatted')
      const expected = variables(source).filter((name) => !numberWords(name))
      const actual = variables(text).filter((name) => !numberWords(name))
      if (JSON.stringify(expected) !== JSON.stringify(actual)) problems.push(`${key}: en ${JSON.stringify(expected)}, ar ${JSON.stringify(actual)}`)
    }
    expect(problems).toEqual([])
  })

  it('have a message for every API error code of the contract and of the client', () => {
    // Every code the TypeScript contract names (a missing one is a type error here).
    const typed: Record<ApiErrorCode | 'NETWORK_ERROR' | 'UNEXPECTED_RESPONSE', true> = {
      BAD_REQUEST: true,
      METHOD_NOT_ALLOWED: true,
      PAYLOAD_TOO_LARGE: true,
      UNSUPPORTED_MEDIA_TYPE: true,
      NOT_AUTHENTICATED: true,
      INVALID_CREDENTIALS: true,
      FORBIDDEN: true,
      CSRF_FAILED: true,
      PASSWORD_CHANGE_REQUIRED: true,
      INVALID_RESET_TOKEN: true,
      INVALID_CURRENT_PASSWORD: true,
      NOT_FOUND: true,
      CONFLICT: true,
      USER_EMAIL_UNAVAILABLE: true,
      LAST_ADMIN: true,
      SELF_MODIFICATION: true,
      VISITOR_EXISTS: true,
      INVALID_STATE_TRANSITION: true,
      VISIT_NOT_EDITABLE: true,
      VISIT_ALREADY_CHECKED_IN: true,
      VISIT_NOT_CHECKED_IN: true,
      VISITOR_ALREADY_INSIDE: true,
      VISIT_CANCELLED: true,
      VISIT_COMPLETED: true,
      HOST_INACTIVE: true,
      PASS_NOT_YET_VALID: true,
      PASS_EXPIRED: true,
      PASS_REVOKED: true,
      PASS_INVALID: true,
      VISITOR_EMAIL_REQUIRED: true,
      WALK_INS_DISABLED: true,
      OVERRIDE_NOT_ALLOWED: true,
      VALIDATION_ERROR: true,
      RATE_LIMITED: true,
      INVITATION_LIMIT: true,
      SERVICE_BUSY: true,
      INTERNAL_ERROR: true,
      COMPANY_INACTIVE: true,
      ACCOUNT_INACTIVE: true,
      TRACKING_NOT_AVAILABLE: true,
      TRACKING_KEY_LIMIT: true,
      LOCATION_IN_USE: true,
      NETWORK_ERROR: true,
      UNEXPECTED_RESPONSE: true,
    }
    const codes = new Set([...contract.error_codes, ...Object.keys(typed)])
    const missing = (['en', 'ar'] as const).flatMap((language) => {
      const catalog = resources[language].errors.codes as Record<string, string>
      return [...codes].filter((code) => !catalog[code]).map((code) => `${language}: ${code}`)
    })
    expect(missing).toEqual([])
  })

  it('say «تسجيل الدخول» for checking a visitor in, never «تسجيل الوصول», and no «مسجّل دخوله» for a named person (review)', () => {
    // One term across the screens, the errors and the e-mails (backend/app/email/i18n.py has the same test);
    // and «مسجّل دخوله» ("he is checked in") read as a man's state beside a woman's name.
    const forbidden = /(?:تسجيل|سجّل|سُجّل|يُسجَّل|يسجّل|سيسجّل)\s+وصول|مسجّل\s+(?:دخوله|وصوله)|حسابه الخاص/
    const problems: string[] = []
    for (const namespace of NAMESPACES) {
      for (const [key, text] of flatten(resources.ar[namespace] as Catalog)) if (forbidden.test(text)) problems.push(`${namespace}:${key}: ${text}`)
    }
    expect(problems).toEqual([])
  })

  it('name a role beside one person as a job title and the people who hold it as a team (final touches)', () => {
    // Under one person's name the team reads wrongly («عمر خليل · الموظفون»): the shell's user block,
    // the account menu, the role chips of the users list and the user dialogs say the job title.
    expect(resources.ar.common.roles.person).toEqual({
      SYSTEM_ADMIN: 'مدير النظام',
      EMPLOYEE: 'موظف',
      RECEPTIONIST: 'موظف استقبال',
      MANAGEMENT: 'الإدارة العليا',
    })
    // Where people are counted or picked out by their role (the role filter), the teams.
    expect(resources.ar.common.roles.group).toEqual({
      SYSTEM_ADMIN: 'إدارة النظام',
      EMPLOYEE: 'الموظفون',
      RECEPTIONIST: 'الاستقبال',
      MANAGEMENT: 'الإدارة العليا',
    })
    // English names a role the same way in both places, as it did before.
    const english = { SYSTEM_ADMIN: 'Administrator', EMPLOYEE: 'Employee', RECEPTIONIST: 'Reception', MANAGEMENT: 'Management' }
    expect(resources.en.common.roles.person).toEqual(english)
    expect(resources.en.common.roles.group).toEqual(english)
    // The user dialogs' sentences name a role as its tile there does.
    const { person } = resources.ar.common.roles
    const { cancelsVisitsRoles, ownAdminRole } = resources.ar.admin.users.editDialog
    expect([...cancelsVisitsRoles.matchAll(/«([^»]+)»/g)].map((match) => match[1])).toEqual([person.EMPLOYEE, person.SYSTEM_ADMIN])
    expect(ownAdminRole).toContain(`دور ${person.SYSTEM_ADMIN} `)
  })

  it('write Arabic in Arabic: no Latin letters in the Arabic texts except names that stay Latin', () => {
    // The Latin words the Arabic UI uses: UTC (time zone offsets) and QR («رمز QR», as the
    // e-mails and the mockups write it), and the calendars a visit is added to by their own names
    // («تقويم Google», «Outlook», «تقويم Apple وغيره (ملف ics)», Phase 14, F14-1).
    const allowed = /\b(UTC|QR|Google|Outlook|Apple|ics)\b/g
    const problems: string[] = []
    for (const namespace of NAMESPACES) {
      for (const [key, text] of flatten(resources.ar[namespace] as Catalog)) {
        const words = text.replace(/\{\{\s*\w+\s*\}\}/g, '').replace(allowed, '')
        if (/[A-Za-z]/.test(words)) problems.push(`${namespace}:${key}`)
      }
    }
    expect(problems).toEqual([])
  })
})
