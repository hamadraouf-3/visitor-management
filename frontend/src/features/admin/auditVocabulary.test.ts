// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { i18n } from '../../i18n'
import contract from '../../types/backend-contract.json'
import { auditEventQualifier, formatMetadataValue, metadataValueText } from './auditFormat'

/*
 * Every audit metadata key and value the backend writes has words in both languages (review
 * finding: the Arabic audit log showed «المصدر: Visit inline», «Has email: نعم» and the chip
 * «رفض تسجيل الدخول [Visit already checked in]», English words humanised from codes the catalog
 * did not know). The keys and values are read from the backend's source, as `auditLabels.test.ts`
 * reads its action names, so a key or value added there fails here until the catalog has it.
 *
 * What is read (backend/app, every module):
 * - keys: the dict literals written as audit metadata (`metadata={...}`, `metadata = {...}`,
 *   `metadata: dict[...] = {...}`, `event_metadata = {...}`, the dict arguments of `_audit*(...)`, the
 *   dicts returned by `*metadata*()` helpers), `metadata["key"] = ...`, and the marks the security
 *   writer's coalescer adds (`_emit(..., overflow=True)`);
 * - values: the string values of those dicts, the literals given to the parameters that end up in
 *   metadata (`reason=`, `operation=`, `trigger=`, the sign-in verification's and the password
 *   change's reasons), the enums written as values (rate-limit policies, scan outcomes, pass revoke
 *   reasons, roles, visit statuses, check-in and check-out methods, CSRF reasons, walk-in reasons),
 *   every API error code (a refused check-in records its `code`) and every field a PATCH can change
 *   (`changed_fields`, from the contract's update requests).
 * The outbox provider's `metadata` (the development outbox's own JSON file) is not audit metadata.
 */

const BACKEND_APP = fileURLToPath(new URL('../../../../backend/app', import.meta.url))
const NOT_AUDIT = new Set(['email/providers/outbox.py'])

function pythonFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return entry.name === '__pycache__' ? [] : pythonFiles(path)
    return entry.name.endsWith('.py') ? [path] : []
  })
}

const SOURCES = pythonFiles(BACKEND_APP)
  .filter((path) => !NOT_AUDIT.has(relative(BACKEND_APP, path).replaceAll('\\', '/')))
  // The modules have CRLF line ends on Windows checkouts.
  .map((path) => ({ path, text: readFileSync(path, 'utf8').replaceAll('\r\n', '\n') }))

/** The text from an opening bracket to its matching closing one (strings skipped). */
function balanced(text: string, open: number): string {
  const pairs: Record<string, string> = { '{': '}', '(': ')', '[': ']' }
  const stack: string[] = []
  let quote: string | null = null
  for (let index = open; index < text.length; index += 1) {
    const char = text[index]!
    if (quote) {
      if (char === '\\') index += 1
      else if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") quote = char
    else if (char in pairs) stack.push(pairs[char]!)
    else if (char === stack[stack.length - 1]) {
      stack.pop()
      if (stack.length === 0) return text.slice(open, index + 1)
    }
  }
  throw new Error(`Unbalanced bracket at ${open}`)
}

/** The audit metadata dict literals of a module. */
function metadataDicts(text: string): string[] {
  const dicts: string[] = []
  for (const match of text.matchAll(/\b\w*metadata\w*\s*(?::[^=\n]+)?=\s*\{/g)) dicts.push(balanced(text, match.index + match[0].length - 1))
  for (const match of text.matchAll(/\b_audit\w*\(/g)) {
    const call = balanced(text, match.index + match[0].length - 1)
    for (const dict of call.matchAll(/[(,]\s*\{/g)) dicts.push(balanced(call, dict.index + dict[0].length - 1))
  }
  for (const match of text.matchAll(/def \w*metadata\w*\([^)]*\)[^:]*:\n((?:(?: {8,}.*)?\n)+)/g)) {
    const body = match[1]!
    for (const ret of body.matchAll(/return \{/g)) dicts.push(balanced(body, ret.index + ret[0].length - 1))
  }
  return dicts
}

function backendKeys(): Set<string> {
  const keys = new Set<string>()
  for (const { text } of SOURCES) {
    for (const dict of metadataDicts(text)) for (const match of dict.matchAll(/"([a-z][a-z0-9_]*)"\s*:/g)) keys.add(match[1]!)
    for (const match of text.matchAll(/\bmetadata\["([a-z][a-z0-9_]*)"\]\s*=/g)) keys.add(match[1]!)
    for (const match of text.matchAll(/\b_emit\([^)]*?\b([a-z][a-z0-9_]*)=True/g)) keys.add(match[1]!)
  }
  return keys
}

/** The members of a Python `StrEnum` class body or the strings of a `Literal[...]` alias. */
function enumValues(name: string): string[] {
  for (const { text } of SOURCES) {
    const start = text.indexOf(`class ${name}(StrEnum):`)
    if (start !== -1) {
      const values: string[] = []
      for (const line of text.slice(start).split('\n').slice(1)) {
        if (line.trim() && !line.startsWith(' ')) break
        const match = /^\s+[A-Z][A-Z0-9_]*\s*=\s*"([^"]+)"/.exec(line)
        if (match) values.push(match[1]!)
      }
      return values
    }
    const literal = new RegExp(`^${name} = Literal\\[([^\\]]+)\\]`, 'm').exec(text)
    if (literal) return [...literal[1]!.matchAll(/"([^"]+)"/g)].map((match) => match[1]!)
  }
  throw new Error(`${name} not found in backend/app`)
}

const METADATA_ENUMS = [
  'PolicyName',
  'ScanOutcome',
  'PassRevokeReason',
  'Role',
  'VisitStatus',
  'CheckInMethod',
  'CheckOutMethod',
  'CsrfFailureReason',
  'WalkInReason',
  // Phase 15: why a visit's tracking ended (`reason`), and the provider (`provider`).
  'TrackingEndReason',
  'TrackingProviderName',
]
const UPDATE_REQUESTS = [
  'CompanySettingsUpdate',
  'DepartmentUpdate',
  'UserUpdate',
  'VisitUpdate',
  'VisitorUpdate',
  // Phase 15: the fields a change of the tracking's settings, a camera or a place names (`changed_fields`).
  'TrackingSettingsUpdate',
  'TrackingCameraUpdate',
  'BuildingUpdate',
  'FloorUpdate',
  'ZoneUpdate',
] as const

function backendValues(): Set<string> {
  const values = new Set<string>()
  const code = /^[A-Za-z][A-Za-z0-9_]*$/
  for (const { text } of SOURCES) {
    for (const dict of metadataDicts(text)) for (const match of dict.matchAll(/"[a-z_]+"\s*:\s*"([^"]+)"/g)) values.add(match[1]!)
    for (const match of text.matchAll(/\b(?:reason|operation|trigger|source)="([a-z][a-z0-9_]*)"/g)) values.add(match[1]!)
    for (const match of text.matchAll(/\b(?:_Verification|_change_failed)\(\w+, "([a-z][a-z0-9_]*)"/g)) values.add(match[1]!)
    for (const match of text.matchAll(/\b_login_failed\([^)]*\bor "([a-z][a-z0-9_]*)"/g)) values.add(match[1]!)
    const problem = /def _account_problem\([^)]*\)[^:]*:\n((?:(?: {8,}.*)?\n)+)/.exec(text)
    if (problem) for (const match of problem[1]!.matchAll(/return "([a-z][a-z0-9_]*)"/g)) values.add(match[1]!)
  }
  for (const name of METADATA_ENUMS) for (const value of enumValues(name)) values.add(value)
  for (const value of contract.error_codes) values.add(value)
  // Each request is a `$ref` into the snapshot's shared `$defs`.
  const defs = contract.$defs as Record<string, { properties?: Record<string, unknown> }>
  for (const name of UPDATE_REQUESTS) {
    const fields = Object.keys(defs[name]?.properties ?? {})
    expect(fields.length, `${name} fields`).toBeGreaterThan(0)
    for (const field of fields) values.add(field)
  }
  return new Set([...values].filter((value) => code.test(value)))
}

/** Latin letters in Arabic text, but for the words the Arabic UI keeps (QR, UTC; catalogs.test.ts). */
const LATIN = /[A-Za-z]/
const KEPT_LATIN = /\b(?:QR|UTC)\b/g
/** Values that read the same in every language (HTTP methods, written as the server sent them). */
const LATIN_EVERYWHERE = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])

describe('the audit vocabulary and the backend', () => {
  const keys = backendKeys()
  const values = backendValues()
  const previous = i18n.language
  beforeAll(() => void i18n.changeLanguage('en'))
  afterAll(() => void i18n.changeLanguage(previous))

  it('reads the keys and values the backend writes', () => {
    // Known ones from each kind of source, so a change to the backend's style shows here first.
    const knownKeys = ['changed_fields', 'has_email', 'notice', 'notice_limited_by', 'id_verified', 'duration_seconds', 'overflow', 'coalesced', 'route', 'trigger', 'host_notified']
    expect(knownKeys.filter((key) => !keys.has(key))).toEqual([])
    const knownValues = ['cli', 'visit_inline', 'visitors_api', 'user', 'limited', 'interrupted', 'unknown_account', 'inactive', 'session_ended', 'create', 'VISIT_ALREADY_CHECKED_IN', 'login_failures_ip', 'cross_site', 'ROTATED', 'name_ar']
    expect(knownValues.filter((value) => !values.has(value))).toEqual([])
    expect(keys.size).toBeGreaterThan(35)
    expect(values.size).toBeGreaterThan(120)
  })

  it.each(['en', 'ar'] as const)('names every metadata key in %s', (lng) => {
    expect([...keys].filter((key) => !i18n.exists(`audit.metadataKeys.${key}`, { ns: 'admin', lng }))).toEqual([])
  })

  it.each(['en', 'ar'] as const)('has words for every value in %s (Arabic without Latin letters)', async (lng) => {
    await i18n.changeLanguage(lng)
    const problems: string[] = []
    for (const value of values) {
      const text = metadataValueText(value)
      if (text === null) problems.push(`${value}: no words`)
      else if (lng === 'ar' && LATIN.test(text.replace(KEPT_LATIN, '')) && !LATIN_EVERYWHERE.has(value)) problems.push(`${value}: «${text}»`)
    }
    expect(problems).toEqual([])
  })

  // The event's chip (`auditEventQualifier`) reads one of these keys; it must say what the details say
  // (finding L-22: every walk-in reason was an English chip in the Arabic list, over «السبب: توصيل»).
  it.each(['en', 'ar'] as const)('words every value in the event’s chip as its details do, in %s', async (lng) => {
    await i18n.changeLanguage(lng)
    const problems: string[] = []
    for (const value of values) {
      for (const key of ['outcome', 'reason', 'code', 'policy']) {
        const chip = auditEventQualifier({ metadata: { [key]: value } })
        const details = formatMetadataValue(value, key)
        if (chip !== details || chip !== metadataValueText(value)) problems.push(`${key}=${value}: chip «${chip}», details «${details}»`)
        else if (lng === 'ar' && LATIN.test(chip.replace(KEPT_LATIN, '')) && !LATIN_EVERYWHERE.has(value)) problems.push(`${key}=${value}: «${chip}»`)
      }
    }
    expect(problems).toEqual([])
  })

  it('names every walk-in reason in the walk-in event’s chip, in Arabic as in the visits', async () => {
    await i18n.changeLanguage('ar')
    const chips = ['NO_INVITATION', 'EARLY_ARRIVAL', 'LATE_ARRIVAL', 'LOST_PASS', 'DELIVERY', 'OTHER'].map((reason) =>
      auditEventQualifier({ metadata: { visitor_reused: false, reason } }),
    )
    expect(chips).toEqual(['بدون دعوة', 'وصول مبكر', 'وصول متأخر', 'بطاقة مفقودة', 'توصيل', 'سبب آخر'])
    await i18n.changeLanguage('en')
    expect(auditEventQualifier({ metadata: { reason: 'DELIVERY' } })).toBe('Delivery')
  })

  it('names a refused check-in’s error code in the event’s chip, in Arabic', async () => {
    await i18n.changeLanguage('ar')
    expect(auditEventQualifier({ metadata: { method: 'MANUAL', code: 'VISIT_ALREADY_CHECKED_IN' } })).toBe('سبق تسجيل الدخول')
    // A code the audit vocabulary has no short words for reads as the error's message, never as English words.
    expect(auditEventQualifier({ metadata: { code: 'SERVICE_BUSY' } })).toBe('الخدمة مشغولة. يُرجى المحاولة مرة أخرى')
    await i18n.changeLanguage('en')
    expect(auditEventQualifier({ metadata: { method: 'MANUAL', code: 'VISIT_ALREADY_CHECKED_IN' } })).toBe('Visit already checked in')
  })
})
