import { describe, expect, it } from 'vitest'
import type { User } from '../../types/api'
import { generateTemporaryPassword, TEMPORARY_PASSWORD_ALPHABET } from './temporaryPassword'
import {
  cancelledVisitsMessage,
  cancelsHostedVisits,
  EMPTY_USER_CREATE,
  selfEditLocks,
  toUserCreate,
  toUserUpdate,
  userEditValues,
  validateTemporaryPassword,
  validateUserCreate,
  validateUserEdit,
} from './userForm'

const user: User = {
  id: 'u-1',
  full_name: 'Omar Khalil',
  email: 'omar@acme.example',
  phone: '+962 79 000 0077',
  roles: ['EMPLOYEE'],
  department: { id: 'd-1', name: 'Legal', name_ar: null },
  is_active: true,
  must_change_password: false,
  last_login_at: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
}

describe('validateUserCreate', () => {
  it('requires a name, an email, a role and a temporary password', () => {
    const errors = validateUserCreate(EMPTY_USER_CREATE)
    expect(errors.fullName).toBe('Enter the person’s full name.')
    expect(errors.email).toBe('Enter the email address the person signs in with.')
    expect(errors.roles).toBe('Choose at least one role.')
    expect(errors.temporaryPassword).toBe('Enter a temporary password, or generate one.')
    expect(errors.phone).toBeUndefined()
  })

  it('checks lengths and the email shape', () => {
    const errors = validateUserCreate({
      fullName: 'x'.repeat(201),
      email: 'not an email',
      phone: '1'.repeat(41),
      roles: ['EMPLOYEE'],
      departmentId: '',
      temporaryPassword: 'short',
    })
    expect(errors).toMatchObject({
      fullName: 'Enter at most 200 characters.',
      email: 'Enter a valid email address, like name@company.com.',
      phone: 'Enter at most 40 characters.',
      temporaryPassword: 'Use at least 12 characters.',
    })
  })

  it('accepts special-use domains such as .local (B1-22)', () => {
    expect(validateUserCreate({ ...EMPTY_USER_CREATE, fullName: 'A', email: 'a@demo.local', roles: ['EMPLOYEE'], temporaryPassword: 'x'.repeat(12) })).toEqual(
      expect.not.objectContaining({ email: expect.any(String) }),
    )
  })
})

describe('validateTemporaryPassword', () => {
  it('applies the policy the browser can check (§7.1)', () => {
    expect(validateTemporaryPassword('a'.repeat(11), 'x@y.z')).toBe('Use at least 12 characters.')
    expect(validateTemporaryPassword('a'.repeat(129), 'x@y.z')).toBe('Use at most 128 characters.')
    expect(validateTemporaryPassword(' Person@Acme.example ', 'person@acme.example')).toBe('The password must not be the email address.')
    // Counted in code points, like the server.
    expect(validateTemporaryPassword('🔑'.repeat(12), 'x@y.z')).toBeUndefined()
  })
})

describe('toUserCreate', () => {
  it('trims, puts the roles in their canonical order and leaves out empty optional fields', () => {
    expect(
      toUserCreate({
        fullName: '  Rana Saleh ',
        email: ' Rana@Acme.Example ',
        phone: '  ',
        roles: ['EMPLOYEE', 'SYSTEM_ADMIN'],
        departmentId: '',
        temporaryPassword: ' keep spaces ok ',
      }),
    ).toEqual({ full_name: 'Rana Saleh', email: 'rana@acme.example', roles: ['SYSTEM_ADMIN', 'EMPLOYEE'], temporary_password: ' keep spaces ok ' })
  })

  it('sends a phone and a department when given', () => {
    expect(toUserCreate({ ...EMPTY_USER_CREATE, fullName: 'A', email: 'a@b.co', phone: '079', roles: ['MANAGEMENT'], departmentId: 'd-1', temporaryPassword: 'p' })).toMatchObject({
      phone: '079',
      department_id: 'd-1',
    })
  })
})

describe('toUserUpdate', () => {
  it('sends only what changed', () => {
    expect(toUserUpdate(user, userEditValues(user))).toBeNull()
    expect(toUserUpdate(user, { ...userEditValues(user), fullName: ' Omar  K. ' })).toEqual({ full_name: 'Omar  K.' })
    expect(toUserUpdate(user, { ...userEditValues(user), roles: ['EMPLOYEE', 'RECEPTIONIST'] })).toEqual({ roles: ['EMPLOYEE', 'RECEPTIONIST'] })
    expect(toUserUpdate(user, { ...userEditValues(user), isActive: false })).toEqual({ is_active: false })
  })

  it('clears a phone or department with null', () => {
    expect(toUserUpdate(user, { ...userEditValues(user), phone: ' ', departmentId: '' })).toEqual({ phone: null, department_id: null })
  })

  it('treats the same roles in another order as unchanged', () => {
    const admin = { ...user, roles: ['SYSTEM_ADMIN', 'EMPLOYEE'] as User['roles'] }
    expect(toUserUpdate(admin, { ...userEditValues(admin), roles: ['EMPLOYEE', 'SYSTEM_ADMIN'] })).toBeNull()
  })

  it('validates name, phone and roles', () => {
    expect(validateUserEdit({ ...userEditValues(user), fullName: ' ', roles: [] })).toMatchObject({
      fullName: 'Enter the person’s full name.',
      roles: 'Choose at least one role.',
    })
  })
})

describe('selfEditLocks', () => {
  it('never offers self-demotion or self-deactivation (§7.5)', () => {
    const admin = { id: 'me', roles: ['SYSTEM_ADMIN', 'EMPLOYEE'] as User['roles'] }
    expect(selfEditLocks(admin, 'me')).toEqual({ adminRole: true, active: true })
    expect(selfEditLocks(admin, 'someone-else')).toEqual({ adminRole: false, active: false })
    expect(selfEditLocks({ id: 'me', roles: ['EMPLOYEE'] }, 'me')).toEqual({ adminRole: false, active: true })
  })
})

describe('cancelsHostedVisits (D-18)', () => {
  it('is true for a deactivation or the loss of the last host role', () => {
    expect(cancelsHostedVisits(user, { roles: ['EMPLOYEE'], isActive: false })).toBe(true)
    expect(cancelsHostedVisits(user, { roles: ['RECEPTIONIST'], isActive: true })).toBe(true)
    expect(cancelsHostedVisits(user, { roles: ['SYSTEM_ADMIN'], isActive: true })).toBe(false)
    expect(cancelsHostedVisits({ roles: ['MANAGEMENT'], is_active: true }, { roles: ['RECEPTIONIST'], isActive: true })).toBe(false)
    expect(cancelsHostedVisits({ roles: ['EMPLOYEE'], is_active: false }, { roles: ['EMPLOYEE'], isActive: false })).toBe(false)
    // Someone who cannot host has no hosted visits: deactivating them warns of nothing.
    expect(cancelsHostedVisits({ roles: ['RECEPTIONIST'], is_active: true }, { roles: ['RECEPTIONIST'], isActive: false })).toBe(false)
    expect(cancelsHostedVisits({ roles: ['MANAGEMENT', 'SYSTEM_ADMIN'], is_active: true }, { roles: ['MANAGEMENT', 'SYSTEM_ADMIN'], isActive: false })).toBe(true)
  })

  it('reports how many visits were cancelled', () => {
    expect(cancelledVisitsMessage('Omar Khalil', 1)).toBe('1 scheduled visit hosted by Omar Khalil was cancelled.')
    expect(cancelledVisitsMessage('Omar Khalil', 3)).toBe('3 scheduled visits hosted by Omar Khalil were cancelled.')
  })
})

describe('generateTemporaryPassword', () => {
  it('builds four groups of five unambiguous characters', () => {
    const password = generateTemporaryPassword()
    expect(password).toMatch(/^[^-]{5}-[^-]{5}-[^-]{5}-[^-]{5}$/)
    for (const character of password.replaceAll('-', '')) expect(TEMPORARY_PASSWORD_ALPHABET).toContain(character)
    expect(validateTemporaryPassword(password, 'someone@acme.example')).toBeUndefined()
    expect(TEMPORARY_PASSWORD_ALPHABET).not.toMatch(/[0O1lIo]/)
  })

  it('rejects biased bytes instead of folding them with a modulo', () => {
    // 56 symbols: bytes 224–255 would favour the first 32 symbols, so they are drawn again.
    const bytes = [255, 224, 0, ...Array.from({ length: 19 }, (_, index) => index)]
    let position = 0
    const password = generateTemporaryPassword((buffer) => {
      buffer[0] = bytes[position] ?? 0
      position += 1
    })
    expect(password.startsWith(TEMPORARY_PASSWORD_ALPHABET[0]!)).toBe(true)
    expect(position).toBe(22)
  })

  it('differs between calls', () => {
    expect(new Set(Array.from({ length: 20 }, () => generateTemporaryPassword())).size).toBe(20)
  })
})
