import type { CreateWorkspaceRequest, WorkspaceResponse } from '@nexus/shared'
import { apiClient } from './client'
import { encodeWorkspacePath } from '../lib/workspace-path'

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
  return apiClient.delete<void>(`/api/workspaces/${encodeWorkspacePath(path)}`)
}

export async function fetchFiles(workspacePath: string): Promise<FileEntry[]> {
  const res = await apiClient.get<{ files: FileEntry[] }>(`/api/workspaces/${encodeWorkspacePath(workspacePath)}/files`)
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
  return apiClient.get<GitInfo | GitErrorResponse>(`/api/workspaces/${encodeWorkspacePath(workspacePath)}/git`)
}

export interface GitDiffResponse {
  diff: string
}

export interface GitShowResponse {
  message: string
  files: string[]
  stat: string
}

export async function fetchGitDiff(
  workspacePath: string,
  file: string,
  staged: boolean,
): Promise<GitDiffResponse> {
  const params = new URLSearchParams({ file, staged: staged ? 'true' : 'false' })
  return apiClient.get<GitDiffResponse>(`/api/workspaces/${encodeWorkspacePath(workspacePath)}/git/diff?${params}`)
}

export async function fetchGitShow(workspacePath: string, hash: string): Promise<GitShowResponse> {
  const params = new URLSearchParams({ hash })
  return apiClient.get<GitShowResponse>(`/api/workspaces/${encodeWorkspacePath(workspacePath)}/git/show?${params}`)
}

export interface FileContentResponse {
  content: string
  language: string
}

export interface BinaryFileResponse {
  binary: true
  size: number
}

export async function fetchFileContent(
  workspacePath: string,
  filePath: string,
): Promise<FileContentResponse | BinaryFileResponse> {
  const params = new URLSearchParams({ filePath })
  return apiClient.get<FileContentResponse | BinaryFileResponse>(
    `/api/workspaces/${encodeWorkspacePath(workspacePath)}/files/content?${params.toString()}`,
  )
}
