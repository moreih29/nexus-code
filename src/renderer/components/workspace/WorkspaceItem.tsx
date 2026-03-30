import { Folder, X } from 'lucide-react'
import type { WorkspaceEntry } from '../../../shared/types'
import { useWorkspaceStore } from '../../stores/workspace-store'
import { getOrCreateWorkspaceStore, setActiveStore } from '../../stores/session-store'
import { useRightPanelUIStore } from '../../stores/plugin-store'

interface WorkspaceItemProps {
  workspace: WorkspaceEntry
}

function shortenPath(path: string): string {
  return path.replace(/^\/Users\/[^/]+\//, '~/')
}

export function WorkspaceItem({ workspace }: WorkspaceItemProps) {
  const { activeWorkspace, setActiveWorkspace, removeWorkspace } = useWorkspaceStore()

  const isActive = activeWorkspace === workspace.path

  const handleWorkspaceClick = async (): Promise<void> => {
    if (activeWorkspace === workspace.path) return

    // RightPanel 타이머 정리
    useRightPanelUIStore.getState().cleanup()

    // 워크스페이스 전환
    setActiveWorkspace(workspace.path)

    // 새 워크스페이스의 store 가져오기/생성
    const store = getOrCreateWorkspaceStore(workspace.path)
    setActiveStore(store)

    // 세션 복원 (store에 아직 sessionId가 없고, workspace에 저장된 sessionId가 있을 때만)
    if (workspace.sessionId && !store.getState().sessionId) {
      await store.getState().restoreSession(workspace.sessionId)
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
