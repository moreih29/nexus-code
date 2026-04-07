import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { CreateWorkspaceRequest } from '@nexus/shared'
import { fetchWorkspaces, createWorkspace, deleteWorkspace, fetchFiles, fetchGitInfo, fetchFileContent } from '../api/workspace'

export const workspacesQueryKey = ['workspaces'] as const

export function useWorkspaces() {
  return useQuery({
    queryKey: workspacesQueryKey,
    queryFn: fetchWorkspaces,
  })
}

export function useCreateWorkspace() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: CreateWorkspaceRequest) => createWorkspace(body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: workspacesQueryKey })
    },
  })
}

export function useDeleteWorkspace() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (path: string) => deleteWorkspace(path),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: workspacesQueryKey })
    },
  })
}

export function useFiles(workspacePath: string | null | undefined) {
  return useQuery({
    queryKey: ['workspace-files', workspacePath],
    queryFn: () => fetchFiles(workspacePath!),
    enabled: !!workspacePath,
  })
}

export function useGitInfo(workspacePath: string | null | undefined) {
  return useQuery({
    queryKey: ['workspace-git', workspacePath],
    queryFn: () => fetchGitInfo(workspacePath!),
    enabled: !!workspacePath,
    refetchInterval: 5000,
  })
}

export function useFileContent(workspacePath: string | null | undefined, filePath: string | null | undefined) {
  return useQuery({
    queryKey: ['file-content', workspacePath, filePath],
    queryFn: () => fetchFileContent(workspacePath!, filePath!),
    enabled: !!workspacePath && !!filePath,
    staleTime: 30_000,
  })
}
