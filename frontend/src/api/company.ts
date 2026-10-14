import type { CompanySettings, CompanySettingsUpdate } from '../types/api'
import { apiRequest, type CallOptions } from './client'

export function getCompanySettings(options?: CallOptions): Promise<CompanySettings> {
  return apiRequest('/company/settings', options)
}

export function updateCompanySettings(body: CompanySettingsUpdate, options?: CallOptions): Promise<CompanySettings> {
  return apiRequest('/company/settings', { ...options, method: 'PATCH', body })
}
