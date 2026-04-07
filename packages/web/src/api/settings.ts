import { apiClient } from './client'

export interface SessionSettings {
  model?: string
  permissionMode?: 'auto' | 'bypassPermissions'
  effortLevel?: string
  maxTurns?: number
}

export function updateSessionSettings(
  sessionId: string,
  settings: SessionSettings
): Promise<{ id: string; settings: SessionSettings; status: string }> {
  return apiClient.put(`/api/sessions/${sessionId}/settings`, settings)
}
