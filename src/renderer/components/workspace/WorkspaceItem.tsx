import { Folder } from 'lucide-react'
import type { WorkspaceEntry } from '../../../shared/types'
import { useWorkspaceStore } from '../../stores/workspace-store'
import { useSessionStore } from '../../stores/session-store'

interface WorkspaceItemProps {
  workspace: WorkspaceEntry
}

export function WorkspaceItem({ workspace }: WorkspaceItemProps) {
  const { activeWorkspace, setActiveWorkspace } = useWorkspaceStore()
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

  return (
    <div
      className={[
        'flex w-full items-center gap-1 rounded-md px-2 py-2 text-left transition-colors cursor-pointer',
        isActive ? 'bg-blue-900/40 text-foreground' : 'text-foreground hover:bg-muted hover:text-foreground',
      ].join(' ')}
      onClick={handleWorkspaceClick}
    >
      <Folder size={14} className="shrink-0 text-muted-foreground" />

      <span className="flex-1 truncate text-sm font-medium" title={workspace.path}>
        {workspace.name}
      </span>
    </div>
  )
}
