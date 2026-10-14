// @vitest-environment node
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { i18n } from '../../i18n'
import { auditEventQualifier, formatMetadataValue, metadataEntries, metadataJson } from './auditFormat'
import {
  AUDIT_ENTITY_LABELS,
  auditActionLabel,
  auditEntityDescription,
  auditEntityLink,
  humanizeAuditCode,
  isFailureEvent,
  KNOWN_AUDIT_ACTIONS,
} from './auditLabels'

const AUDIT_MODULE = fileURLToPath(new URL('../../../../backend/app/services/audit.py', import.meta.url))

/** The members of a Python `StrEnum` class body: `NAME = "VALUE"`. */
function enumValues(source: string, className: string): string[] {
  const start = source.indexOf(`class ${className}(StrEnum):`)
  if (start === -1) throw new Error(`class ${className} not found in ${AUDIT_MODULE}`)
  const body = source.slice(start).split('\n').slice(1)
  const values: string[] = []
  for (const line of body) {
    if (line.trim() && !line.startsWith(' ')) break
    const match = /^\s+[A-Z][A-Z0-9_]*\s*=\s*"([^"]+)"/.exec(line)
    if (match) values.push(match[1]!)
  }
  return values
}

describe('audit labels and the backend', () => {
  const source = readFileSync(AUDIT_MODULE, 'utf8')

  it('names every action the backend records (AuditAction)', () => {
    const actions = enumValues(source, 'AuditAction')
    expect(actions.length).toBeGreaterThan(20)
    expect(actions.filter((action) => !KNOWN_AUDIT_ACTIONS.includes(action))).toEqual([])
  })

  it('offers no action the backend does not record', () => {
    const actions = new Set(enumValues(source, 'AuditAction'))
    expect(KNOWN_AUDIT_ACTIONS.filter((action) => !actions.has(action))).toEqual([])
  })

  it('names every entity type the backend records (AuditEntity)', () => {
    const entities = enumValues(source, 'AuditEntity')
    expect(entities.filter((entity) => !(entity in AUDIT_ENTITY_LABELS))).toEqual([])
  })
})

describe('auditActionLabel', () => {
  it('reads actions in words, also unknown ones', () => {
    expect(auditActionLabel('USER_ROLES_CHANGED')).toBe('User roles changed')
    expect(auditActionLabel('AUTH_LOGIN_FAILED')).toBe('Sign-in failed')
    expect(auditActionLabel('SOMETHING_NEW_HAPPENED')).toBe('Something new happened')
    expect(humanizeAuditCode('bad_password')).toBe('Bad password')
  })

  it('marks failures and denials, including unusable scans', () => {
    expect(isFailureEvent({ action: 'ACCESS_DENIED', metadata: {} })).toBe(true)
    expect(isFailureEvent({ action: 'PASS_SCANNED', metadata: { outcome: 'INVALID' } })).toBe(true)
    expect(isFailureEvent({ action: 'PASS_SCANNED', metadata: { outcome: 'READY' } })).toBe(false)
    expect(isFailureEvent({ action: 'USER_UPDATED', metadata: {} })).toBe(false)
  })

  it('takes a qualifier from the outcome, reason or policy', () => {
    expect(auditEventQualifier({ metadata: { outcome: 'PASS_EXPIRED' } })).toBe('Pass expired')
    expect(auditEventQualifier({ metadata: { reason: 'bad_password' } })).toBe('Bad password')
    expect(auditEventQualifier({ metadata: { changed_fields: ['name'] } })).toBeNull()
  })
})

describe('auditEntityLink', () => {
  it('opens visits and visitors, and filters the log for everything else', () => {
    expect(auditEntityLink({ entity_type: 'visit', entity_id: 'a1' })).toBe('/visits/a1')
    expect(auditEntityLink({ entity_type: 'visitor', entity_id: 'b2' })).toBe('/visitors/b2')
    expect(auditEntityLink({ entity_type: 'user', entity_id: 'c3' })).toBe('/admin/audit?entity_type=user&entity_id=c3')
    expect(auditEntityLink({ entity_type: null, entity_id: null })).toBeNull()
  })

  it('says "Own account" when a user acted on their own account, and never shows a raw id', () => {
    const actor = { id: 'c3', full_name: 'Lina Haddad' }
    expect(auditEntityDescription({ entity_type: 'user', entity_id: 'c3', actor })).toBe('Own account')
    expect(auditEntityDescription({ entity_type: 'user', entity_id: 'd4', actor })).toBe('User')
    expect(auditEntityDescription({ entity_type: 'visit', entity_id: 'a1', actor })).toBe('Visit')
    expect(auditEntityDescription({ entity_type: null, entity_id: null, actor })).toBeNull()
  })
})

describe('audit metadata as text', () => {
  it('formats values for reading, enum codes in the words of the event’s badge', () => {
    expect(formatMetadataValue(['full_name', 'phone'])).toBe('Full name, Phone')
    expect(formatMetadataValue('PASS_EXPIRED')).toBe('Pass expired')
    expect(formatMetadataValue('QR')).toBe('QR code')
    // Check-in and check-out methods in the words of the history's badges (one vocabulary).
    expect(formatMetadataValue('CORRECTED')).toBe('Corrected check-out')
    expect(formatMetadataValue('BULK')).toBe('Bulk check-out')
    expect(formatMetadataValue('WALK_IN')).toBe('Walk-in')
    expect(formatMetadataValue('SYSTEM_ADMIN')).toBe('Administrator')
    expect(formatMetadataValue('NO_SHOW')).toBe('No-show')
    expect(formatMetadataValue('bad_password')).toBe('Bad password')
    // Ids and free text stay as they are.
    expect(formatMetadataValue('7f0d1c0e-1111-4a5b-9c1d-000000000077')).toBe('7f0d1c0e-1111-4a5b-9c1d-000000000077')
    expect(formatMetadataValue('Office closed')).toBe('Office closed')
    expect(formatMetadataValue([])).toBe('None')
    expect(formatMetadataValue(true)).toBe('Yes')
    expect(formatMetadataValue(null)).toBe('—')
    expect(formatMetadataValue(12_500)).toBe('12,500')
    expect(formatMetadataValue({ nested: 1 })).toBe('{"nested":1}')
  })

  it('reads an account’s roles as job titles in Arabic, never as the teams (final touches)', async () => {
    await i18n.changeLanguage('ar')
    const entries = metadataEntries({ added: ['EMPLOYEE', 'RECEPTIONIST'], removed: ['SYSTEM_ADMIN'] })
    expect(entries.map((entry) => entry.value)).toEqual(['موظف، موظف استقبال', 'مدير النظام'])
  })

  it('names every metadata key the backend records in both languages (no English words in the Arabic details)', () => {
    // The keys of the `metadata` the backend's audit writers record (services/*.py, email/dispatcher.py).
    const keys = [
      'changed_fields', 'checked_in_before', 'coalesced', 'code', 'count', 'deferred', 'department_id', 'email_message_id', 'method',
      'minutes', 'operation', 'outcome', 'pass_id', 'policy', 'reason', 'revoked_sessions', 'roles', 'route', 'session_id', 'source',
    ]
    for (const key of keys) {
      for (const lng of ['en', 'ar'] as const) expect(i18n.exists(`audit.metadataKeys.${key}`, { ns: 'admin', lng }), `${lng}: ${key}`).toBe(true)
    }
    // The catalog's words in English too ("Session ID", not the code in words).
    expect(metadataEntries({ session_id: 'abc' })[0]?.label).toBe('Session ID')
    expect(metadataEntries({ changed_fields: ['name_ar', 'is_active'] })[0]?.value).toBe('Arabic name, Active')
    // A key a newer backend writes still reads as words.
    expect(metadataEntries({ brand_new_key: 'x' })[0]?.label).toBe('Brand new key')
  })

  it('keeps markup as plain characters (rendered as text, never parsed)', () => {
    const metadata = { route: '<img src=x onerror=alert(1)>', changed_fields: ['<b>name</b>'] }
    expect(metadataEntries(metadata)).toEqual([
      { key: 'route', label: 'Route', value: '<img src=x onerror=alert(1)>' },
      { key: 'changed_fields', label: 'Changed fields', value: '<b>name</b>' },
    ])
    expect(metadataJson(metadata)).toContain('"<img src=x onerror=alert(1)>"')
  })
})
