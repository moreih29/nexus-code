import type { CreateWorkspaceRequest, WorkspaceResponse } from '@nexus/shared'
import { apiClient } from './client'

export interface FileEntry {
  path: string
  status?: 'M' | 'A' | 'D'
}

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

export async function fetchFiles(workspacePath: string): Promise<FileEntry[]> {
  const encoded = workspacePath.replace(/^\//, '')
  const res = await apiClient.get<{ files: FileEntry[] }>(`/api/workspaces/${encoded}/files`)
  return res.files
}

export interface GitFileEntry {
  path: string
  status: string
  additions: number
  deletions: number
}

export interface GitCommit {
  hash: string
  message: string
  date: string
}

export interface GitInfo {
  branch: string
  staged: GitFileEntry[]
  changes: GitFileEntry[]
  commits: GitCommit[]
}

export interface GitErrorResponse {
  error: string
}

export async function fetchGitInfo(workspacePath: string): Promise<GitInfo | GitErrorResponse> {
  const encoded = workspacePath.replace(/^\//, '')
  return apiClient.get<GitInfo | GitErrorResponse>(`/api/workspaces/${encoded}/git`)
}
