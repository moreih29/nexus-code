import type { CreateWorkspaceRequest, WorkspaceResponse } from '@nexus/shared'
import { apiClient } from './client'

export function fetchWorkspaces(): Promise<WorkspaceResponse[]> {
  return apiClient.get<WorkspaceResponse[]>('/api/workspaces')
}

export function createWorkspace(body: CreateWorkspaceRequest): Promise<WorkspaceResponse> {
  return apiClient.post<WorkspaceResponse>('/api/workspaces', body)
}

export function deleteWorkspace(path: string): Promise<void> {
  return apiClient.delete<void>(`/api/workspaces/${encodeURIComponent(path)}`)
}
