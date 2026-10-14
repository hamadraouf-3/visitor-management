import { PERSON_ROLE_LABELS } from '../../auth/roles'
import { VISIT_STATUS_META } from '../../components/ui/statusMeta'
import { i18n } from '../../i18n'
import { catalogText } from '../../i18n/catalogText'
import type { AuditLog, Role, VisitStatus } from '../../types/api'
import { formatDateKey, isDateKey } from '../../utils/datetime'
import { formatDuration } from '../../utils/duration'
import { joinList } from '../../utils/text'
import { VISIT_METHOD_SHORT_LABELS, walkInReasonLabel } from '../visits/labels'
import { auditCodeText, humanizeAuditCode } from './auditLabels'

const t = i18n.getFixedT(null, 'admin')

/**
 * Audit metadata holds IDs, enums, counts, booleans and changed-field names (§3.2-8). These
 * helpers turn it into plain strings; the UI renders them as text (React escapes it), never as
 * markup, so a value can never inject HTML whatever the server stored.
 */

/**
 * HTTP methods of a denied or refused request (`method` next to `route`): technical names that
 * read the same in every language, shown as the server wrote them.
 */
const HTTP_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])

/**
 * Enum values whose words come from the app's own tables (check-in and check-out methods, roles,
 * visit statuses, walk-in reasons), in the UI language. Read at each call: the tables read the
 * catalogs when read. Roles in the audit are always one account's (`roles`, `added`, `removed`), so
 * they read as beside a person («موظف استقبال», not the team «الاستقبال»).
 */
function tableLabel(code: string): string | undefined {
  if (code in VISIT_METHOD_SHORT_LABELS) return VISIT_METHOD_SHORT_LABELS[code as keyof typeof VISIT_METHOD_SHORT_LABELS]
  if (code in PERSON_ROLE_LABELS) return PERSON_ROLE_LABELS[code as Role]
  if (code in VISIT_STATUS_META) return VISIT_STATUS_META[code as VisitStatus].label
  const walkInReason = walkInReasonLabel(code)
  return walkInReason === code ? undefined : walkInReason
}

/** A code as the server writes it: an enum ("PASS_EXPIRED", "QR"), a reason or a field name ("bad_password", "phone"). */
const ENUM_VALUE = /^(?:[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*|[a-z][a-z0-9]*(?:_[a-z0-9]+)*)$/

/**
 * The words of a code the server writes as a metadata value, in the UI language, or null when
 * neither the app's tables nor the catalog know it (a newer server's code). `auditVocabulary.test.ts`
 * checks every value the backend writes against this.
 */
export function metadataValueText(code: string): string | null {
  if (HTTP_METHODS.has(code)) return code
  return tableLabel(code) ?? auditCodeText(code)
}

/** A company's e-mail text named as `<language>.<field>` (`changed`, `reset` of the e-mail texts' events, Phase 11). */
const TEMPLATE_FIELD_VALUE = /^(ar|en)\.([a-z][a-z_]*)$/

/** "ar.subject" → "Subject (Arabic)", in the UI language; null for any other value. */
export function templateFieldText(value: string): string | null {
  const match = TEMPLATE_FIELD_VALUE.exec(value)
  if (!match) return null
  const field = catalogText('admin', `emailTemplates.fields.${match[2]!}`)
  const language = catalogText('admin', `audit.values.${match[1]!}`)
  return field && language ? t('audit.templateField', { field, language }) : null
}

/** Metadata keys whose numbers are a length of time in seconds. */
const DURATION_KEYS: ReadonlySet<string> = new Set(['duration_seconds'])

/**
 * One metadata value as text: enum codes in words ("PASS_EXPIRED" → "Pass expired", the words
 * the event's badge uses; a code no table knows in words of its own), a company-local date
 * ("2026-10-07") as a date, a duration in seconds as a duration, lists joined, booleans as Yes/No,
 * nested objects as compact JSON. The raw codes stay readable in the event's raw JSON.
 */
export function formatMetadataValue(value: unknown, key?: string): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'boolean') return value ? t('audit.yes') : t('audit.no')
  if (typeof value === 'number') {
    if (key !== undefined && DURATION_KEYS.has(key) && Number.isFinite(value)) return formatDuration(value)
    return Number.isFinite(value) ? value.toLocaleString('en-GB') : String(value)
  }
  if (typeof value === 'string') {
    if (isDateKey(value)) return formatDateKey(value)
    const templateField = templateFieldText(value)
    if (templateField !== null) return templateField
    return ENUM_VALUE.test(value) || HTTP_METHODS.has(value) ? (metadataValueText(value) ?? humanizeAuditCode(value)) : value
  }
  if (Array.isArray(value)) return value.length === 0 ? t('audit.none') : joinList(value.map((item) => formatMetadataValue(item, key)))
  return JSON.stringify(value)
}

/** The metadata keys whose value says what kind of event it was, in the order they are looked at. */
const QUALIFIER_KEYS = ['outcome', 'reason', 'code', 'policy'] as const

/**
 * A short qualifier from the metadata that changes what the event means, e.g. a scan's outcome,
 * why a sign-in failed, the error a refused check-in got or why a walk-in was registered:
 * "Invalid", "Bad password", "Pass expired", "Delivery". Worded exactly as the event's details
 * word the same value (`formatMetadataValue`, so the app's own tables first: a walk-in reason in
 * the Arabic list read "Delivery" over details that said «السبب: توصيل», L-22). Null when there is none.
 */
export function auditEventQualifier(log: Pick<AuditLog, 'metadata'>): string | null {
  for (const key of QUALIFIER_KEYS) {
    const value = log.metadata[key]
    if (typeof value === 'string' && value) return formatMetadataValue(value, key)
  }
  return null
}

export interface MetadataEntry {
  key: string
  label: string
  value: string
}

/** A metadata key in words: the catalog's for the keys it knows, else the key in words (a newer backend's). */
function metadataKeyLabel(key: string): string {
  return catalogText('admin', `audit.metadataKeys.${key}`) ?? humanizeAuditCode(key)
}

/** The metadata as labelled entries, in the order the server wrote them. */
export function metadataEntries(metadata: Record<string, unknown>): MetadataEntry[] {
  return Object.entries(metadata).map(([key, value]) => ({ key, label: metadataKeyLabel(key), value: formatMetadataValue(value, key) }))
}

/** The raw metadata, indented, for the "raw" view (shown as preformatted text). */
export function metadataJson(metadata: Record<string, unknown>): string {
  return JSON.stringify(metadata, null, 2)
}
