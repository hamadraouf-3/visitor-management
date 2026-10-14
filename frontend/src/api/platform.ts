import type { BrandAssetKind } from '../identity/brand'
import type {
  AdminPasswordResetSent,
  BrandPalette,
  BrandPaletteRequest,
  ChangePasswordRequest,
  CompanyAdminCreate,
  CompanyBrand,
  CompanyBrandUpdate,
  EmailPreview,
  EmailPreviewDocumentParams,
  EmailTemplate,
  EmailTemplateKind,
  EmailTemplatePreviewRequest,
  EmailTemplateReset,
  EmailTemplateUpdate,
  EmailTestSent,
  LoginRequest,
  PlatformAuditLogListParams,
  PlatformAuditLogPage,
  PlatformCompany,
  PlatformCompanyAdmin,
  PlatformCompanyCreate,
  PlatformCompanyCreated,
  PlatformCompanyListParams,
  PlatformCompanyPage,
  PlatformCompanyUpdate,
  PlatformMe,
  PreferencesUpdate,
} from '../types/api'
import { apiRequest, apiUrl, segment, type CallOptions } from './client'

/*
 * The platform owner's API (Phase 11, docs/api.md §10.11). Every path is under `/platform`, so the
 * client sends the platform session's own CSRF token (`csrfCookieNamesFor`), never the company's.
 */

/* Session ----------------------------------------------------------------------------------- */

export function platformLogin(body: LoginRequest, options?: CallOptions): Promise<PlatformMe> {
  return apiRequest('/platform/auth/login', { ...options, method: 'POST', body })
}

export function platformLogout(options?: CallOptions): Promise<void> {
  return apiRequest('/platform/auth/logout', { ...options, method: 'POST' })
}

export function getPlatformMe(options?: CallOptions): Promise<PlatformMe> {
  return apiRequest('/platform/auth/me', options)
}

/** 204 with new platform session and CSRF cookies; every platform session of the account ends. */
export function platformChangePassword(body: ChangePasswordRequest, options?: CallOptions): Promise<void> {
  return apiRequest('/platform/auth/change-password', { ...options, method: 'POST', body })
}

/** The platform pages' language; allowed during a forced password change. */
export function updatePlatformPreferences(body: PreferencesUpdate, options?: CallOptions): Promise<PlatformMe> {
  return apiRequest('/platform/auth/preferences', { ...options, method: 'PATCH', body })
}

/* Companies --------------------------------------------------------------------------------- */

export function listPlatformCompanies(params: PlatformCompanyListParams, options?: CallOptions): Promise<PlatformCompanyPage> {
  return apiRequest('/platform/companies', { ...options, query: params })
}

export function createPlatformCompany(body: PlatformCompanyCreate, options?: CallOptions): Promise<PlatformCompanyCreated> {
  return apiRequest('/platform/companies', { ...options, method: 'POST', body })
}

export function getPlatformCompany(id: string, options?: CallOptions): Promise<PlatformCompany> {
  return apiRequest(`/platform/companies/${segment(id)}`, options)
}

export function updatePlatformCompany(id: string, body: PlatformCompanyUpdate, options?: CallOptions): Promise<PlatformCompany> {
  return apiRequest(`/platform/companies/${segment(id)}`, { ...options, method: 'PATCH', body })
}

/** Ends the company's sessions and refuses its sign-ins, reset links and passes; idempotent. */
export function deactivatePlatformCompany(id: string, options?: CallOptions): Promise<PlatformCompany> {
  return apiRequest(`/platform/companies/${segment(id)}/deactivate`, { ...options, method: 'POST' })
}

export function reactivatePlatformCompany(id: string, options?: CallOptions): Promise<PlatformCompany> {
  return apiRequest(`/platform/companies/${segment(id)}/reactivate`, { ...options, method: 'POST' })
}

/* A company's administrators ---------------------------------------------------------------- */

export function listCompanyAdmins(companyId: string, options?: CallOptions): Promise<PlatformCompanyAdmin[]> {
  return apiRequest(`/platform/companies/${segment(companyId)}/admins`, options)
}

export function createCompanyAdmin(companyId: string, body: CompanyAdminCreate, options?: CallOptions): Promise<PlatformCompanyAdmin> {
  return apiRequest(`/platform/companies/${segment(companyId)}/admins`, { ...options, method: 'POST', body })
}

/** The product's reset e-mail to an active administrator of an active company (202). */
export function sendCompanyAdminPasswordReset(companyId: string, userId: string, options?: CallOptions): Promise<AdminPasswordResetSent> {
  return apiRequest(`/platform/companies/${segment(companyId)}/admins/${segment(userId)}/password-reset`, { ...options, method: 'POST' })
}

/* Audit ------------------------------------------------------------------------------------- */

export function listPlatformAuditLogs(params: PlatformAuditLogListParams, options?: CallOptions): Promise<PlatformAuditLogPage> {
  return apiRequest('/platform/audit-logs', { ...options, query: params })
}

/* A company's identity (Phase 12) ------------------------------------------------------------- */

const brandPath = (companyId: string) => `/platform/companies/${segment(companyId)}/brand`

export function getCompanyBrand(companyId: string, options?: CallOptions): Promise<CompanyBrand> {
  return apiRequest(brandPath(companyId), options)
}

/**
 * Stores one of the identity's files: the PNG the browser prepared (`identity/imagePipeline.ts`), as
 * the raw body. The server accepts `image/png` only and validates it strictly (415 for another type,
 * 413 when too large, 422 with a field error on `file`).
 */
export function uploadCompanyBrandAsset(companyId: string, kind: BrandAssetKind, png: Blob, options?: CallOptions): Promise<CompanyBrand> {
  return apiRequest(`${brandPath(companyId)}/assets/${segment(kind)}`, { ...options, method: 'PUT', binary: { body: png, contentType: 'image/png' } })
}

export function deleteCompanyBrandAsset(companyId: string, kind: BrandAssetKind, options?: CallOptions): Promise<CompanyBrand> {
  return apiRequest(`${brandPath(companyId)}/assets/${segment(kind)}`, { ...options, method: 'DELETE' })
}

/** The company's colour (`#rrggbb`), or null for the default palette; the server derives the palette. */
export function updateCompanyBrand(companyId: string, body: CompanyBrandUpdate, options?: CallOptions): Promise<CompanyBrand> {
  return apiRequest(brandPath(companyId), { ...options, method: 'PATCH', body })
}

/** The palette a colour would give, for the live preview: nothing is saved. */
export function previewBrandPalette(body: BrandPaletteRequest, options?: CallOptions): Promise<BrandPalette> {
  return apiRequest('/platform/brand/palette', { ...options, method: 'POST', body })
}

/* A company's e-mail texts, for the platform owner (Phase 12) --------------------------------- */

/*
 * The company's own endpoints (`api/emailTemplates.ts`) mirrored under the company: the same shapes,
 * validation and limits. The test e-mail goes to the platform owner's own address.
 */

const templatesPath = (companyId: string) => `/platform/companies/${segment(companyId)}/email-templates`

export function listCompanyEmailTemplates(companyId: string, options?: CallOptions): Promise<EmailTemplate[]> {
  return apiRequest(templatesPath(companyId), options)
}

export function getCompanyEmailTemplate(companyId: string, kind: EmailTemplateKind, options?: CallOptions): Promise<EmailTemplate> {
  return apiRequest(`${templatesPath(companyId)}/${segment(kind)}`, options)
}

export function updateCompanyEmailTemplate(companyId: string, kind: EmailTemplateKind, body: EmailTemplateUpdate, options?: CallOptions): Promise<EmailTemplate> {
  return apiRequest(`${templatesPath(companyId)}/${segment(kind)}`, { ...options, method: 'PATCH', body })
}

export function resetCompanyEmailTemplate(companyId: string, kind: EmailTemplateKind, body: EmailTemplateReset = {}, options?: CallOptions): Promise<EmailTemplate> {
  return apiRequest(`${templatesPath(companyId)}/${segment(kind)}/reset`, { ...options, method: 'POST', body })
}

export function previewCompanyEmailTemplate(companyId: string, kind: EmailTemplateKind, body: EmailTemplatePreviewRequest, options?: CallOptions): Promise<EmailPreview> {
  return apiRequest(`${templatesPath(companyId)}/${segment(kind)}/preview`, { ...options, method: 'POST', body })
}

export function sendCompanyEmailTemplateTest(companyId: string, kind: EmailTemplateKind, body: EmailTemplatePreviewRequest, options?: CallOptions): Promise<EmailTestSent> {
  return apiRequest(`${templatesPath(companyId)}/${segment(kind)}/test`, { ...options, method: 'POST', body })
}

/** The saved texts' faithful preview, for `<iframe sandbox src>` (as `emailTemplatePreviewUrl`). */
export function companyEmailTemplatePreviewUrl(companyId: string, kind: EmailTemplateKind, params: EmailPreviewDocumentParams): string {
  return apiUrl(`${templatesPath(companyId)}/${segment(kind)}/preview`, params)
}
