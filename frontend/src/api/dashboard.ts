import type { AdminDashboard, EmployeeDashboard } from '../types/api'
import { apiRequest, type CallOptions } from './client'

export function getEmployeeDashboard(options?: CallOptions): Promise<EmployeeDashboard> {
  return apiRequest('/dashboard/employee', options)
}

export function getAdminDashboard(options?: CallOptions): Promise<AdminDashboard> {
  return apiRequest('/dashboard/admin', options)
}
