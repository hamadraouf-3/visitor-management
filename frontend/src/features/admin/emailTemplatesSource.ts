import { createContext, useContext, type ReactNode } from 'react'
import type { CallOptions } from '../../api/client'
import {
  emailTemplatePreviewUrl,
  getEmailTemplate,
  listEmailTemplates,
  previewEmailTemplate,
  resetEmailTemplate,
  sendEmailTemplateTest,
  updateEmailTemplate,
} from '../../api/emailTemplates'
import { queryKeys } from '../../api/queryKeys'
import { paths } from '../../paths'
import type { EmailPreview, EmailPreviewDocumentParams, EmailTemplate, EmailTemplateKind, EmailTemplatePreviewRequest, EmailTemplateUpdate, EmailTestSent } from '../../types/api'

/**
 * Whose e-mail texts the list and the editor work on, and through which endpoints (Phase 12).
 *
 * The same screens serve two people: a company's administrator, on the company's own endpoints
 * (`/email-templates…`, Phase 11), and the platform owner, on the same endpoints mirrored under a
 * company (`/platform/companies/{id}/email-templates…`), with the platform session. Everything that
 * differs between the two is here; the components and their checks are shared.
 */
export interface EmailTemplatesSource {
  keys: {
    list: readonly unknown[]
    detail: (kind: EmailTemplateKind) => readonly unknown[]
    /** A draft's rendering: the request body is part of the key. */
    preview: (kind: EmailTemplateKind, body: unknown) => readonly unknown[]
  }
  /**
   * The key of this source's mutations. The platform owner's are under `queryKeys.platform`, so the
   * company session's end leaves them alone (and the reverse); the company's own need none.
   */
  mutationKey?: (name: string) => readonly unknown[]
  api: {
    list: (options?: CallOptions) => Promise<EmailTemplate[]>
    get: (kind: EmailTemplateKind, options?: CallOptions) => Promise<EmailTemplate>
    update: (kind: EmailTemplateKind, body: EmailTemplateUpdate) => Promise<EmailTemplate>
    reset: (kind: EmailTemplateKind) => Promise<EmailTemplate>
    preview: (kind: EmailTemplateKind, body: EmailTemplatePreviewRequest, options?: CallOptions) => Promise<EmailPreview>
    sendTest: (kind: EmailTemplateKind, body: EmailTemplatePreviewRequest) => Promise<EmailTestSent>
    /** The saved e-mail as a document of its own, for the sandboxed frame. */
    previewUrl: (kind: EmailTemplateKind, params: EmailPreviewDocumentParams) => string
  }
  /** The list's address, and one e-mail's editor. */
  listPath: string
  templatePath: (kind: EmailTemplateKind) => string
  /** The time zone the "changed" dates are given in. */
  timeZone: string
  /** Above the list's title, when the list is a page about somebody else's company: the way back to it. */
  listBack?: { to: string; label: string }
  /**
   * Whose texts these are, when they are somebody else's company's (the platform owner's pages): the
   * company's name above the title of the list and of each e-mail, with its logo beside it
   * (`leading`, decorative), and in the tab's title.
   */
  owner?: { name: string; leading?: ReactNode }
}

/** A company's own e-mail texts, for its administrator (`/admin/email-templates`). */
export function companyEmailTemplatesSource(timeZone: string): EmailTemplatesSource {
  return {
    keys: queryKeys.emailTemplates,
    api: {
      list: listEmailTemplates,
      get: getEmailTemplate,
      update: updateEmailTemplate,
      reset: (kind) => resetEmailTemplate(kind),
      preview: previewEmailTemplate,
      sendTest: sendEmailTemplateTest,
      previewUrl: emailTemplatePreviewUrl,
    },
    listPath: paths.adminEmailTemplates,
    templatePath: paths.adminEmailTemplate,
    timeZone,
  }
}

export const EmailTemplatesSourceContext = createContext<EmailTemplatesSource | null>(null)

/** The source the screens below work on; a page provides it (`EmailTemplatesSourceContext`). */
export function useEmailTemplatesSource(): EmailTemplatesSource {
  const source = useContext(EmailTemplatesSourceContext)
  if (!source) throw new Error('The e-mail texts screens need an EmailTemplatesSourceContext')
  return source
}
