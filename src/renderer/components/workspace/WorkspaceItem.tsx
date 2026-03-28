import { Folder, X } from 'lucide-react'
import type { WorkspaceEntry } from '../../../shared/types'
import { useWorkspaceStore } from '../../stores/workspace-store'
import { useSessionStore } from '../../stores/session-store'

interface WorkspaceItemProps {
  workspace: WorkspaceEntry
}

function shortenPath(path: string): string {
  return path.replace(/^\/Users\/[^/]+\//, '~/')
}

export function WorkspaceItem({ workspace }: WorkspaceItemProps) {
  const { activeWorkspace, setActiveWorkspace, removeWorkspace } = useWorkspaceStore()
  const restoreSession = useSessionStore((s) => s.restoreSession)
  const resetSession = useSessionStore((s) => s.reset)

  const isActive = activeWorkspace === workspace.path

  const handleWorkspaceClick = async (): Promise<void> => {
    if (activeWorkspace === workspace.path) return
    setActiveWorkspace(workspace.path)
    if (workspace.sessionId) {
      await restoreSession(workspace.sessionId)
    } else {
      resetSession()
    }
  }

  const handleRemove = (e: React.MouseEvent): void => {
    e.stopPropagation()
    removeWorkspace(workspace.path)
  }

  return (
    <div
      className={[
        'group flex w-full items-center gap-1 rounded-md px-2 py-2 text-left transition-colors cursor-pointer',
        isActive ? 'bg-blue-900/40 text-foreground' : 'text-foreground hover:bg-muted hover:text-foreground',
      ].join(' ')}
      onClick={handleWorkspaceClick}
    >
      <Folder size={14} className="shrink-0 text-muted-foreground" />

      <div className="flex-1 min-w-0">
        <div className="truncate text-sm font-medium" title={workspace.path}>
          {workspace.name}
        </div>
        <div className="truncate text-xs text-muted-foreground">
          {shortenPath(workspace.path)}
        </div>
      </div>

      <button
        className="opacity-0 group-hover:opacity-100 shrink-0 rounded p-0.5 transition-opacity hover:bg-muted-foreground/20"
        onClick={handleRemove}
        title="워크스페이스 삭제"
      >
        <X size={12} className="text-muted-foreground" />
      </button>
    </div>
  )
}
