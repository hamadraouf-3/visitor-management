import type { Department, DepartmentCreate, DepartmentListParams, DepartmentUpdate } from '../types/api'
import { apiRequest, segment, type CallOptions } from './client'

/** Active departments; `include_inactive` is honoured for admins only. */
export function listDepartments(params: DepartmentListParams = {}, options?: CallOptions): Promise<Department[]> {
  return apiRequest('/departments', { ...options, query: params })
}

export function createDepartment(body: DepartmentCreate, options?: CallOptions): Promise<Department> {
  return apiRequest('/departments', { ...options, method: 'POST', body })
}

export function updateDepartment(id: string, body: DepartmentUpdate, options?: CallOptions): Promise<Department> {
  return apiRequest(`/departments/${segment(id)}`, { ...options, method: 'PATCH', body })
}
