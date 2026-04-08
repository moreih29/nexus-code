import { useWorkspaceStore } from '../stores/workspace-store'
import { useWorkspaces } from './use-workspaces'

export function useActiveWorkspace() {
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)
  const { data: workspaces } = useWorkspaces()

  const workspace = workspaces?.find((ws) => ws.id === activeWorkspaceId)
  const workspacePath = workspace?.path ?? null

  return { workspace, workspacePath, activeWorkspaceId }
}
