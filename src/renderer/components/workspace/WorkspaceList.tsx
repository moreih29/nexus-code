import { memo, useEffect } from 'react'
import { useWorkspaceStore } from '../../stores/workspace-store'
import { useHistoryStore } from '../../stores/history-store'
import { WorkspaceItem } from './WorkspaceItem'
import { AddWorkspaceButton } from './AddWorkspaceButton'

export const WorkspaceList = memo(function WorkspaceList() {
  const { workspaces, loading, loadWorkspaces } = useWorkspaceStore()
  const loadSessions = useHistoryStore((s) => s.loadSessions)

  useEffect(() => {
    loadWorkspaces()
    loadSessions()
  }, [loadWorkspaces, loadSessions])

  return (
    <div className="flex h-full flex-col">
      {/* Workspace list */}
      <div className="flex-1 overflow-y-auto px-2 py-2">
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <span className="text-xs text-dim-foreground">불러오는 중...</span>
          </div>
        ) : workspaces.length === 0 ? (
          <div className="flex items-center justify-center py-8">
            <span className="text-xs text-dim-foreground">워크스페이스 없음</span>
          </div>
        ) : (
          <div className="flex flex-col gap-0.5">
            {workspaces.map((workspace) => (
              <WorkspaceItem key={workspace.path} workspace={workspace} />
            ))}
          </div>
        )}
      </div>

      {/* Add workspace button */}
      <div className="border-t border-border px-2 py-2">
        <AddWorkspaceButton />
      </div>
    </div>
  )
})
