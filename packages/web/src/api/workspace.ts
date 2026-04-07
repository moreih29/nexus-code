import type { CreateWorkspaceRequest, WorkspaceResponse } from '@nexus/shared'
import { apiClient } from './client'

export async function fetchWorkspaces(): Promise<WorkspaceResponse[]> {
  const res = await apiClient.get<{ workspaces: WorkspaceResponse[] }>('/api/workspaces')
  return res.workspaces
}

export function createWorkspace(body: CreateWorkspaceRequest): Promise<WorkspaceResponse> {
  return apiClient.post<WorkspaceResponse>('/api/workspaces', body)
}

export function deleteWorkspace(path: string): Promise<void> {
  return apiClient.delete<void>(`/api/workspaces/${encodeURIComponent(path)}`)
}
