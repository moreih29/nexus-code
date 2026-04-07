import type { SessionResponse, SessionStatus, StartSessionRequest } from '@nexus/shared'
import { apiClient } from './client'

export function startSession(body: StartSessionRequest): Promise<SessionResponse> {
  return apiClient.post<SessionResponse>('/api/sessions', body)
}

export function sendPrompt(sessionId: string, prompt: string): Promise<void> {
  return apiClient.post<void>(`/api/sessions/${sessionId}/prompt`, { prompt })
}

export function cancelSession(sessionId: string): Promise<void> {
  return apiClient.post<void>(`/api/sessions/${sessionId}/cancel`)
}

export function fetchSessionStatus(sessionId: string): Promise<{ status: SessionStatus }> {
  return apiClient.get<{ status: SessionStatus }>(`/api/sessions/${sessionId}/status`)
}
