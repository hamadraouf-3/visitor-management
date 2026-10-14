import { describe, expect, it } from 'vitest'
import { makeMe } from '../test/api'
import { loginPath, postLoginPath, safeNextPath } from './redirect'
import { hasAnyRole, landingPath } from './roles'

const ORIGIN = 'https://visitors.example.com'

describe('safeNextPath', () => {
  it.each([
    ['/visits', '/visits'],
    ['/visits?tab=past&page=2', '/visits?tab=past&page=2'],
    ['/visits/abc#token=secret', '/visits/abc'],
    ['/admin/../reports', '/reports'],
  ])('accepts same-origin relative path %j', (input, expected) => {
    expect(safeNextPath(input, ORIGIN)).toBe(expected)
  })

  it.each([
    ['protocol-relative URL', '//evil.example.com/visits'],
    ['absolute URL', 'https://evil.example.com/visits'],
    ['same-origin absolute URL', `${ORIGIN}/visits`],
    ['backslash trick', '/\\evil.example.com'],
    ['javascript URL', 'javascript:alert(1)'],
    ['relative without slash', 'visits'],
    ['tab character', '/\t/evil.example.com'],
    ['newline', '/visits\n'],
    ['the login page itself', '/login?next=/visits'],
    ['the reset page', '/reset-password'],
    ['the public pass page', '/pass'],
    ['empty', ''],
    // Dot segments that normalise into a protocol-relative path.
    ['dot segment before a double slash', '/.//evil.com'],
    ['encoded dot segment', '/%2e//evil.com'],
    ['encoded double-dot segment', '/%2E%2E//evil.com'],
    ['double-dot segment after a directory', '/x/..//evil.com'],
    ['double-dot segment with a path', '/..//evil.example.com/x'],
    ['dot segment that normalises to a pass page', '/x/../pass'],
  ])('rejects %s', (_label, input) => {
    expect(safeNextPath(input, ORIGIN)).toBeNull()
  })

  it('only ever returns a path that is root-relative and stable under re-validation', () => {
    const inputs = ['/visits', '/a/./b', '/a/b/../c?x=1', '/%2e/visits', '/x/..//evil.com', '/.//evil.com', '/%5Cx', '/a//b']
    const results = inputs.map((input) => safeNextPath(input, ORIGIN)).filter((result) => result !== null)

    expect(results).toEqual(['/visits', '/a/b', '/a/c?x=1', '/visits', '/%5Cx', '/a//b'])
    expect(results.filter((result) => result.startsWith('//') || result.includes('\\'))).toEqual([])
    expect(results.map((result) => safeNextPath(result, ORIGIN))).toEqual(results)
  })

  it('keeps a percent-encoded backslash as a harmless same-origin path', () => {
    expect(safeNextPath('/%5Cevil.example.com', ORIGIN)).toBe('/%5Cevil.example.com')
  })

  it('rejects null and undefined', () => {
    expect(safeNextPath(null, ORIGIN)).toBeNull()
    expect(safeNextPath(undefined, ORIGIN)).toBeNull()
  })

  it('drops search text and names, which never go into an address (SEC-20)', () => {
    expect(safeNextPath('/visitors?page=2&q=jane.doe%40corp.example', ORIGIN)).toBe('/visitors?page=2')
    expect(safeNextPath('/visitors?q=%2B962+79+555+1234', ORIGIN)).toBe('/visitors')
    expect(safeNextPath('/history?status=NO_SHOW,CANCELLED&host=42&hostName=Omar%20Khalil&q=orbit', ORIGIN)).toBe('/history?status=NO_SHOW%2CCANCELLED&host=42')
    // Untouched when there is nothing to drop.
    expect(safeNextPath('/history?status=NO_SHOW,CANCELLED', ORIGIN)).toBe('/history?status=NO_SHOW,CANCELLED')
  })
})

describe('loginPath', () => {
  it('carries the current page as an encoded next parameter', () => {
    expect(loginPath({ pathname: '/visits', search: '?tab=past' })).toBe('/login?next=%2Fvisits%3Ftab%3Dpast')
  })

  it('never carries the search text into the sign-in address (SEC-20)', () => {
    expect(loginPath({ pathname: '/visitors', search: '?q=jane.doe%40corp.example' })).toBe('/login?next=%2Fvisitors')
    expect(loginPath({ pathname: '/visits', search: '?tab=past&q=orbit' })).toBe('/login?next=%2Fvisits%3Ftab%3Dpast')
  })

  it('omits next for the home page and for unsafe locations', () => {
    expect(loginPath({ pathname: '/', search: '' })).toBe('/login')
    expect(loginPath({ pathname: '/login', search: '' })).toBe('/login')
  })
})

describe('landing by role priority (§10)', () => {
  it.each([
    [['RECEPTIONIST'], '/reception'],
    [['SYSTEM_ADMIN'], '/admin'],
    [['EMPLOYEE'], '/visits'],
    [['MANAGEMENT'], '/reports'],
    [['EMPLOYEE', 'RECEPTIONIST'], '/reception'],
    [['SYSTEM_ADMIN', 'RECEPTIONIST'], '/reception'],
    [['EMPLOYEE', 'SYSTEM_ADMIN'], '/admin'],
    [['MANAGEMENT', 'EMPLOYEE'], '/visits'],
    [[], '/visitors'],
  ] as const)('%j → %s', (roles, expected) => {
    expect(landingPath(roles)).toBe(expected)
  })

  it('grants a capability when any role grants it', () => {
    expect(hasAnyRole(['MANAGEMENT', 'EMPLOYEE'], ['EMPLOYEE', 'SYSTEM_ADMIN'])).toBe(true)
    expect(hasAnyRole(['MANAGEMENT'], ['EMPLOYEE', 'SYSTEM_ADMIN'])).toBe(false)
  })

  it('sends users to the forced password change first, then next, then landing', () => {
    expect(postLoginPath(makeMe(['EMPLOYEE'], { must_change_password: true }), '/reports')).toBe('/change-password')
    expect(postLoginPath(makeMe(['EMPLOYEE']), '/visitors')).toBe('/visitors')
    expect(postLoginPath(makeMe(['MANAGEMENT']), null)).toBe('/reports')
  })
})
