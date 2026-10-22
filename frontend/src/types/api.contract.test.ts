// @vitest-environment node
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { compareWithSchema, loadApiTypes, stringLiterals, type ApiTypes, type JsonSchema } from '../test/contractParity'

/**
 * api.ts must mirror the backend's Pydantic schemas (§3.2-9). `backend-contract.json` is the
 * backend's JSON Schema snapshot (`npm run contract:snapshot`); when a backend schema or
 * error code changes, regenerate it and update api.ts until this test passes.
 *
 * Request bodies and query parameters are compared in request mode, response bodies and
 * envelopes (error envelope, `Paginated<T>` instantiations) in response mode.
 */
interface BackendContract {
  description: string
  responses: Record<string, JsonSchema>
  requests: Record<string, JsonSchema>
  queries: Record<string, JsonSchema>
  envelopes: Record<string, JsonSchema>
  error_codes: string[]
  /** Each field error code of a 422 (B10-18) with the names of its parameters. */
  field_error_codes: Record<string, string[]>
  $defs: Record<string, JsonSchema>
}

const contract = JSON.parse(readFileSync(new URL('./backend-contract.json', import.meta.url), 'utf8')) as BackendContract

/** Every top-level key of the snapshot this test consumes. A new section must get a comparison here. */
const HANDLED_SECTIONS = ['$defs', 'description', 'envelopes', 'error_codes', 'field_error_codes', 'queries', 'requests', 'responses']

const SECTION_8_1_RESPONSES = [
  'UserRef',
  'DepartmentRef',
  'Me',
  'User',
  'Host',
  'Department',
  'CompanySettings',
  'Visitor',
  'VisitorSearchItem',
  'Visit',
  'VisitCreateResult',
  'ScanWarning',
  'ScanResult',
  'ScanErrorDetails',
  'ReceptionToday',
  'EmployeeDashboard',
  'AuditLog',
  'AdminDashboard',
  'ReportSummary',
]
const SECTION_8_1_REQUESTS = ['VisitCreate', 'WalkInCreate']

/** §8: the error envelope and the `Paginated<T>` of every paginated endpoint. */
const SECTION_8_ENVELOPES = ['ApiErrorEnvelope', 'UserPage', 'VisitorSearchPage', 'VisitPage', 'AuditLogPage', 'PlatformCompanyPage', 'PlatformAuditLogPage', 'JourneyPage', 'TrackingAlertPage']

/** §8: the query parameters of every endpoint that takes them. */
const SECTION_8_QUERIES = [
  'PageParams',
  'HostSearchParams',
  'UserListParams',
  'DepartmentListParams',
  'VisitorSearchParams',
  'VisitListParams',
  'ReportSummaryParams',
  'AuditLogListParams',
  // Phase 11
  'PlatformCompanyListParams',
  'PlatformAuditLogListParams',
  'EmailPreviewDocumentParams',
  // Phase 12
  'BrandImageParams',
  // Phase 15: the day's journeys, and the cameras with the archived ones
  'JourneyListParams',
  'TrackingCameraListParams',
  // Phase 16: the tracking alerts, and the live map of one building
  'TrackingAlertListParams',
  'LiveJourneyParams',
]

/**
 * Exported api.ts types that no snapshot entry names, each checked another way: the enum
 * aliases through every model property that uses them, `Paginated` through its named
 * instantiations (`*Page`), `ApiErrorCode` against `error_codes`, `FieldErrorCode` against
 * `field_error_codes` (each code's parameters through the catalog test in
 * `i18n/fieldMessages.test.ts`), and the shape of a 422's `details` (free-form in the backend's
 * envelope) through `getFieldErrors`, `getFieldErrorCodes` and their tests.
 */
const CHECKED_INDIRECTLY = [
  'Role',
  'VisitStatus',
  'CheckInMethod',
  'CheckOutMethod',
  'InvitationStatus',
  'PassStatus',
  'PassRevokeReason',
  'WalkInReason',
  'EmailTemplateKind',
  'EmailTemplateFieldName',
  'EmailScheme',
  // Phase 15
  'TrackingProviderName',
  'JourneyState',
  'TrackingAssociationStatus',
  'TrackingEndReason',
  'JourneyEventType',
  'ObservationMatch',
  'EnrollBlocker',
  'TrackingRejectReason',
  'TrackingProviderOperation',
  // Phase 16
  'ZoneAccess',
  'TrackingAlertType',
  'TrackingAlertStatus',
  'TrackingAlertResolution',
  'Paginated',
  'ApiErrorCode',
  'FieldErrorCode',
  'FieldErrorCodeEntry',
  'ValidationErrorDetails',
]

let api: ApiTypes

beforeAll(() => {
  api = loadApiTypes(fileURLToPath(new URL('./api.ts', import.meta.url)))
}, 30_000)

describe('api.ts mirrors the backend contract', () => {
  it('compares every section of the backend snapshot', () => {
    expect(Object.keys(contract).toSorted()).toEqual(HANDLED_SECTIONS)
  })

  it('the backend snapshot covers every §8.1 model, §8 envelope and §8 query', () => {
    expect(Object.keys(contract.responses)).toEqual(expect.arrayContaining(SECTION_8_1_RESPONSES))
    expect(Object.keys(contract.requests)).toEqual(expect.arrayContaining(SECTION_8_1_REQUESTS))
    expect(Object.keys(contract.envelopes).toSorted()).toEqual(SECTION_8_ENVELOPES.toSorted())
    expect(Object.keys(contract.queries).toSorted()).toEqual(SECTION_8_QUERIES.toSorted())
  })

  it('every exported api.ts type is compared with a backend model', () => {
    const compared = new Set([
      ...Object.keys(contract.responses),
      ...Object.keys(contract.requests),
      ...Object.keys(contract.queries),
      ...Object.keys(contract.envelopes),
      ...CHECKED_INDIRECTLY,
    ])
    expect(api.names().filter((name) => !compared.has(name))).toEqual([])
  })

  it.each(Object.entries(contract.responses))('response %s', (name, schema) => {
    expect(compareWithSchema(api, name, schema, 'response', contract.$defs)).toEqual([])
  })

  it.each(Object.entries(contract.envelopes))('envelope %s', (name, schema) => {
    expect(compareWithSchema(api, name, schema, 'response', contract.$defs)).toEqual([])
  })

  it.each(Object.entries(contract.requests))('request %s', (name, schema) => {
    expect(compareWithSchema(api, name, schema, 'request', contract.$defs)).toEqual([])
  })

  it.each(Object.entries(contract.queries))('query %s', (name, schema) => {
    expect(compareWithSchema(api, name, schema, 'request', contract.$defs)).toEqual([])
  })

  it('ApiErrorCode lists exactly the error codes the backend returns', () => {
    expect(stringLiterals(api, 'ApiErrorCode')).toEqual(contract.error_codes.toSorted())
  })

  it('FieldErrorCode lists exactly the field error codes the backend returns', () => {
    expect(stringLiterals(api, 'FieldErrorCode')).toEqual(Object.keys(contract.field_error_codes).toSorted())
  })
})
