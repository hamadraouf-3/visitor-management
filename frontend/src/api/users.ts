import type { Host, HostSearchParams, User, UserCreate, UserListParams, UserPage, UserUpdate } from '../types/api'
import { apiRequest, segment, type CallOptions } from './client'

/** Active hosts (EMPLOYEE or SYSTEM_ADMIN), max 50. Any authenticated role. */
export function searchHosts(params: HostSearchParams = {}, options?: CallOptions): Promise<Host[]> {
  return apiRequest('/users/hosts', { ...options, query: params })
}

export function listUsers(params: UserListParams = {}, options?: CallOptions): Promise<UserPage> {
  return apiRequest('/users', { ...options, query: params })
}

export function createUser(body: UserCreate, options?: CallOptions): Promise<User> {
  return apiRequest('/users', { ...options, method: 'POST', body })
}

export function getUser(id: string, options?: CallOptions): Promise<User> {
  return apiRequest(`/users/${segment(id)}`, options)
}

/** May return `cancelled_visits` when hosted visits were cancelled (D-18). */
export function updateUser(id: string, body: UserUpdate, options?: CallOptions): Promise<User> {
  return apiRequest(`/users/${segment(id)}`, { ...options, method: 'PATCH', body })
}
