import type { HealthResponse } from '../types/api'
import { apiRequest, type CallOptions } from './client'

/** Public liveness + database check; 503 when the database is down. */
export function getHealth(options?: CallOptions): Promise<HealthResponse> {
  return apiRequest('/health', options)
}
