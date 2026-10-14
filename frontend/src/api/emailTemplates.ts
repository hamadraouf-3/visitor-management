import type {
  EmailPreview,
  EmailPreviewDocumentParams,
  EmailTemplate,
  EmailTemplateKind,
  EmailTemplatePreviewRequest,
  EmailTemplateReset,
  EmailTemplateUpdate,
  EmailTestSent,
} from '../types/api'
import { apiRequest, apiUrl, segment, type CallOptions } from './client'

/* A company's e-mail texts (Phase 11, docs/api.md §10.10); company administrators only. */

export function listEmailTemplates(options?: CallOptions): Promise<EmailTemplate[]> {
  return apiRequest('/email-templates', options)
}

export function getEmailTemplate(kind: EmailTemplateKind, options?: CallOptions): Promise<EmailTemplate> {
  return apiRequest(`/email-templates/${segment(kind)}`, options)
}

/** All or nothing: when any text is refused, nothing is saved (422 at `ar.<field>` / `en.<field>`). */
export function updateEmailTemplate(kind: EmailTemplateKind, body: EmailTemplateUpdate, options?: CallOptions): Promise<EmailTemplate> {
  return apiRequest(`/email-templates/${segment(kind)}`, { ...options, method: 'PATCH', body })
}

export function resetEmailTemplate(kind: EmailTemplateKind, body: EmailTemplateReset = {}, options?: CallOptions): Promise<EmailTemplate> {
  return apiRequest(`/email-templates/${segment(kind)}/reset`, { ...options, method: 'POST', body })
}

/** The e-mail with sample data and a draft over the saved texts; nothing is sent or saved. */
export function previewEmailTemplate(kind: EmailTemplateKind, body: EmailTemplatePreviewRequest, options?: CallOptions): Promise<EmailPreview> {
  return apiRequest(`/email-templates/${segment(kind)}/preview`, { ...options, method: 'POST', body })
}

/** Sends that rendering to the caller's own address, "[Test] " before the subject (202; 429 after 5 an hour). */
export function sendEmailTemplateTest(kind: EmailTemplateKind, body: EmailTemplatePreviewRequest, options?: CallOptions): Promise<EmailTestSent> {
  return apiRequest(`/email-templates/${segment(kind)}/test`, { ...options, method: 'POST', body })
}

/**
 * The saved texts' faithful preview, a document of its own with its own sandbox policy (B11-28), for
 * `<iframe sandbox src>`: the SPA's `style-src 'self'` would strip the e-mail's inline styles anywhere else.
 */
export function emailTemplatePreviewUrl(kind: EmailTemplateKind, params: EmailPreviewDocumentParams): string {
  return apiUrl(`/email-templates/${segment(kind)}/preview`, params)
}
