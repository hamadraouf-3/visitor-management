import {
  companyEmailTemplatePreviewUrl,
  getCompanyEmailTemplate,
  listCompanyEmailTemplates,
  previewCompanyEmailTemplate,
  resetCompanyEmailTemplate,
  sendCompanyEmailTemplateTest,
  updateCompanyEmailTemplate,
} from '../../api/platform'
import type { ReactNode } from 'react'
import { queryKeys } from '../../api/queryKeys'
import { paths } from '../../paths'
import type { PlatformCompany } from '../../types/api'
import type { EmailTemplatesSource } from '../admin/emailTemplatesSource'
import { platformTimeZone } from './companyFilters'

/**
 * A company's e-mail texts as the platform owner edits them (Phase 12): the screens of the
 * company's own administrator (`features/admin/EmailTemplate*.tsx`) on the endpoints under the
 * company, with the platform session. Every key is under `queryKeys.platform`, and so is every
 * mutation: the company session of the same browser never touches them. Dates are in the device's
 * time zone, as on every platform page. `leading` is the company's logo tile: with its name it heads
 * both screens, so it is never in doubt whose texts are being changed.
 */
export function platformEmailTemplatesSource(company: PlatformCompany, displayName: string, leading?: ReactNode): EmailTemplatesSource {
  const { id } = company
  const keys = queryKeys.platform.companies.emailTemplates
  return {
    keys: {
      list: keys.list(id),
      detail: (kind) => keys.detail(id, kind),
      preview: (kind, body) => keys.preview(id, kind, body),
    },
    mutationKey: (name) => [...queryKeys.platform.all, name],
    api: {
      list: (options) => listCompanyEmailTemplates(id, options),
      get: (kind, options) => getCompanyEmailTemplate(id, kind, options),
      update: (kind, body) => updateCompanyEmailTemplate(id, kind, body),
      reset: (kind) => resetCompanyEmailTemplate(id, kind),
      preview: (kind, body, options) => previewCompanyEmailTemplate(id, kind, body, options),
      sendTest: (kind, body) => sendCompanyEmailTemplateTest(id, kind, body),
      previewUrl: (kind, params) => companyEmailTemplatePreviewUrl(id, kind, params),
    },
    listPath: paths.platformCompanyEmailTemplates(id),
    templatePath: (kind) => paths.platformCompanyEmailTemplate(id, kind),
    timeZone: platformTimeZone(),
    listBack: { to: paths.platformCompany(id), label: displayName },
    owner: { name: displayName, leading },
  }
}
