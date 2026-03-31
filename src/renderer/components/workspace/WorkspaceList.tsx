import { memo, useEffect } from 'react'
import { FolderPlus } from 'lucide-react'
import { useWorkspaceStore } from '../../stores/workspace-store'
import { useHistoryStore } from '../../stores/history-store'
import { WorkspaceItem } from './WorkspaceItem'
import { AddWorkspaceButton } from './AddWorkspaceButton'
import { EmptyState } from '../ui/empty-state'

interface WorkspaceListProps {
  onOpenWorkspaceSettings?: () => void
}

export const WorkspaceList = memo(function WorkspaceList({ onOpenWorkspaceSettings }: WorkspaceListProps) {
  const { workspaces, loading, loadWorkspaces, addWorkspace } = useWorkspaceStore()
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
          <EmptyState
            size="sm"
            icon={<FolderPlus className="h-full w-full text-dim-foreground" />}
            title="프로젝트 폴더를 추가하세요"
            action={{ label: '+ 폴더 추가', onClick: () => void addWorkspace() }}
          />
        ) : (
          <div className="flex flex-col gap-0.5">
            {workspaces.map((workspace) => (
              <WorkspaceItem
                key={workspace.path}
                workspace={workspace}
                onOpenWorkspaceSettings={onOpenWorkspaceSettings}
              />
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
