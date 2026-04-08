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

export function resumeSession(sessionId: string, prompt = ''): Promise<SessionResponse> {
  return apiClient.post<SessionResponse>(`/api/sessions/${sessionId}/resume`, { prompt })
}

export interface SessionRow {
  id: string
  cli_session_id: string | null
  workspace_path: string
  agent_id: string
  status: string
  model: string | null
  permission_mode: string | null
  prompt: string | null
  created_at: string
  ended_at: string | null
  error_message: string | null
  exit_code: number | null
}

export function fetchSessions(workspacePath: string): Promise<SessionRow[]> {
  return apiClient.get<SessionRow[]>(`/api/sessions?workspacePath=${encodeURIComponent(workspacePath)}`)
}

export interface HistoryMessage {
  type: 'user' | 'assistant' | 'tool_result'
  uuid: string
  content: unknown
  isSidechain: boolean
}

export function fetchHistory(
  sessionId: string,
  opts?: { offset?: number; limit?: number },
): Promise<{ messages: HistoryMessage[]; offset: number; limit: number }> {
  const params = new URLSearchParams()
  if (opts?.offset !== undefined) params.set('offset', String(opts.offset))
  if (opts?.limit !== undefined) params.set('limit', String(opts.limit))
  const qs = params.toString()
  return apiClient.get(`/api/sessions/${sessionId}/history${qs ? `?${qs}` : ''}`)
}
