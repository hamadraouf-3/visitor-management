import { i18n, type Language } from '../../i18n'
import type { CompanyAdminCreate, PlatformCompany, PlatformCompanyCreate, PlatformCompanyUpdate } from '../../types/api'
import { maxLengthMessage, type FieldErrorCodes, type FormErrors, type ServerFieldPaths } from '../../utils/forms'
import { validateTemporaryPassword } from '../admin/userForm'

const t = i18n.getFixedT(null, ['platform', 'auth'])

/** Column limits (§4, B11-12); the server enforces the same. */
export const COMPANY_LIMITS = { name: 200, nameAr: 200, slug: 80, fullName: 200, email: 320 } as const

/** The product's default time zone for a new company (the demo company's). */
export const DEFAULT_COMPANY_TIMEZONE = 'Asia/Amman'

/** 1–80 lowercase letters, digits and hyphens, no hyphen at either end (the backend's `_SLUG`). */
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/

// Deliberately permissive (`.local` / `.test` domains, B1-22): the server validates addresses.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * A slug suggested from a company's English name: accents dropped, every run of other characters a
 * single hyphen, no hyphen at either end, at most 80 characters ("Nova Labs, Inc." → "nova-labs-inc").
 * Empty when the name has no Latin letter or digit (an Arabic name): the slug is then typed.
 */
export function suggestSlug(name: string): string {
  const ascii = name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
  const slug = ascii.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return slug.slice(0, COMPANY_LIMITS.slug).replace(/-+$/, '')
}

export function isValidSlug(slug: string): boolean {
  return SLUG_PATTERN.test(slug)
}

/* The company's identity ---------------------------------------------------------------------- */

export interface CompanyIdentityValues {
  name: string
  /** '' = no Arabic name. */
  nameAr: string
  timezone: string
  defaultLanguage: Language
}

function validateIdentity(values: CompanyIdentityValues): FormErrors<keyof CompanyIdentityValues> {
  const name = values.name.trim()
  return {
    name: !name ? t('form.validation.nameRequired') : name.length > COMPANY_LIMITS.name ? maxLengthMessage(COMPANY_LIMITS.name) : undefined,
    nameAr: values.nameAr.trim().length > COMPANY_LIMITS.nameAr ? maxLengthMessage(COMPANY_LIMITS.nameAr) : undefined,
    timezone: values.timezone ? undefined : t('form.validation.timezoneRequired'),
  }
}

/* A new company and its first administrator ------------------------------------------------------ */

export interface NewCompanyValues extends CompanyIdentityValues {
  slug: string
  /** The slug was typed (no longer follows the name). */
  slugEdited: boolean
  adminFullName: string
  adminEmail: string
  adminPassword: string
}

export type NewCompanyField = Exclude<keyof NewCompanyValues, 'slugEdited'>

export const EMPTY_NEW_COMPANY: NewCompanyValues = {
  name: '',
  nameAr: '',
  slug: '',
  slugEdited: false,
  timezone: DEFAULT_COMPANY_TIMEZONE,
  defaultLanguage: 'ar',
  adminFullName: '',
  adminEmail: '',
  adminPassword: '',
}

/** The form's fields and the request paths the server reports them under (`details.fields`). */
export const NEW_COMPANY_FIELDS: ServerFieldPaths<NewCompanyField> = {
  name: 'name',
  nameAr: 'name_ar',
  slug: 'slug',
  timezone: 'timezone',
  defaultLanguage: 'default_language',
  adminFullName: 'admin.full_name',
  adminEmail: 'admin.email',
  adminPassword: 'admin.temporary_password',
}

/** A taken slug (409 CONFLICT, `details.field = "slug"`) and a taken address belong on their fields. */
export const NEW_COMPANY_CODES: FieldErrorCodes<NewCompanyField> = { CONFLICT: 'slug', USER_EMAIL_UNAVAILABLE: 'adminEmail' }

/** The new company's values after a name change: the slug follows the name until it is typed. */
export function withName(values: NewCompanyValues, name: string): NewCompanyValues {
  return { ...values, name, slug: values.slugEdited ? values.slug : suggestSlug(name) }
}

function validateAdmin(fullName: string, email: string, password: string) {
  const name = fullName.trim()
  const address = email.trim()
  return {
    fullName: !name ? t('form.validation.fullNameRequired') : name.length > COMPANY_LIMITS.fullName ? maxLengthMessage(COMPANY_LIMITS.fullName) : undefined,
    email: !address
      ? t('form.validation.emailRequired')
      : address.length > COMPANY_LIMITS.email
        ? maxLengthMessage(COMPANY_LIMITS.email)
        : EMAIL_PATTERN.test(address)
          ? undefined
          : t('auth:validation.emailInvalid', { example: 'name@company.com' }),
    password: validateTemporaryPassword(password, email),
  }
}

export function validateNewCompany(values: NewCompanyValues): FormErrors<NewCompanyField> {
  const slug = values.slug.trim()
  const admin = validateAdmin(values.adminFullName, values.adminEmail, values.adminPassword)
  return {
    ...validateIdentity(values),
    slug: !slug ? t('form.validation.slugRequired') : isValidSlug(slug) ? undefined : t('form.validation.slugFormat'),
    adminFullName: admin.fullName,
    adminEmail: admin.email,
    adminPassword: admin.password,
  }
}

/** POST /platform/companies: trimmed text, no Arabic name when empty, the address in lower case. */
export function toCompanyCreate(values: NewCompanyValues): PlatformCompanyCreate {
  const body: PlatformCompanyCreate = {
    name: values.name.trim(),
    slug: values.slug.trim(),
    timezone: values.timezone,
    default_language: values.defaultLanguage,
    admin: { full_name: values.adminFullName.trim(), email: values.adminEmail.trim().toLowerCase(), temporary_password: values.adminPassword },
  }
  const nameAr = values.nameAr.trim()
  if (nameAr) body.name_ar = nameAr
  return body
}

/* Editing a company --------------------------------------------------------------------------------- */

export const COMPANY_EDIT_FIELDS: ServerFieldPaths<keyof CompanyIdentityValues> = {
  name: 'name',
  nameAr: 'name_ar',
  timezone: 'timezone',
  defaultLanguage: 'default_language',
}

export function companyIdentityValues(company: PlatformCompany): CompanyIdentityValues {
  return { name: company.name, nameAr: company.name_ar ?? '', timezone: company.timezone, defaultLanguage: company.default_language }
}

export function validateCompanyEdit(values: CompanyIdentityValues): FormErrors<keyof CompanyIdentityValues> {
  return validateIdentity(values)
}

/** PATCH /platform/companies/{id} with only what changed (a cleared Arabic name is sent as null), or null. */
export function toCompanyUpdate(company: PlatformCompany, values: CompanyIdentityValues): PlatformCompanyUpdate | null {
  const body: PlatformCompanyUpdate = {}
  const name = values.name.trim()
  if (name !== company.name) body.name = name
  const nameAr = values.nameAr.trim()
  if (nameAr !== (company.name_ar ?? '')) body.name_ar = nameAr || null
  if (values.timezone !== company.timezone) body.timezone = values.timezone
  if (values.defaultLanguage !== company.default_language) body.default_language = values.defaultLanguage
  return Object.keys(body).length > 0 ? body : null
}

/* Another administrator ----------------------------------------------------------------------------- */

export interface AdminValues {
  fullName: string
  email: string
  temporaryPassword: string
}

export const EMPTY_ADMIN: AdminValues = { fullName: '', email: '', temporaryPassword: '' }

export const ADMIN_FIELDS: ServerFieldPaths<keyof AdminValues> = { fullName: 'full_name', email: 'email', temporaryPassword: 'temporary_password' }

export const ADMIN_CODES: FieldErrorCodes<keyof AdminValues> = { USER_EMAIL_UNAVAILABLE: 'email' }

export function validateAdminValues(values: AdminValues): FormErrors<keyof AdminValues> {
  const admin = validateAdmin(values.fullName, values.email, values.temporaryPassword)
  return { fullName: admin.fullName, email: admin.email, temporaryPassword: admin.password }
}

export function toAdminCreate(values: AdminValues): CompanyAdminCreate {
  return { full_name: values.fullName.trim(), email: values.email.trim().toLowerCase(), temporary_password: values.temporaryPassword }
}
