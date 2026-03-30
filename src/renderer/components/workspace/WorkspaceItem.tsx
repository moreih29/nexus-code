import { Folder, X } from 'lucide-react'
import { useRef, useState } from 'react'
import { useStore } from 'zustand'
import type { WorkspaceEntry } from '../../../shared/types'
import { useWorkspaceStore } from '../../stores/workspace-store'
import { getOrCreateWorkspaceStore, setActiveStore } from '../../stores/session-store'
import { useRightPanelUIStore } from '../../stores/plugin-store'
import { useToast } from '../ui/toast'

interface WorkspaceItemProps {
  workspace: WorkspaceEntry
}

function shortenPath(path: string): string {
  return path.replace(/^\/Users\/[^/]+\//, '~/')
}

export function WorkspaceItem({ workspace }: WorkspaceItemProps) {
  const { activeWorkspace, setActiveWorkspace, removeWorkspace } = useWorkspaceStore()
  const showToast = useToast()
  const [removed, setRemoved] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const isActive = activeWorkspace === workspace.path

  const workspaceStore = getOrCreateWorkspaceStore(workspace.path)
  const sessionStatus = useStore(workspaceStore, (s) => s.status)
  const sessionId = useStore(workspaceStore, (s) => s.sessionId)

  if (removed) return null

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

    // 낙관적 삭제: 화면에서 즉시 숨김
    setRemoved(true)

    // 3초 후 실제 삭제 확정
    timerRef.current = setTimeout(() => {
      void removeWorkspace(workspace.path)
    }, 3000)

    // Undo toast 표시
    showToast(
      `'${workspace.name}' 워크스페이스를 제거했습니다.`,
      {
        label: '되돌리기',
        onClick: () => {
          if (timerRef.current) clearTimeout(timerRef.current)
          setRemoved(false)
        },
      },
      3000,
    )
  }

  return (
    <div
      className={[
        'group relative flex w-full items-center gap-1 rounded-md px-2 py-2 text-left transition-colors cursor-pointer',
        isActive ? 'bg-primary/15 text-foreground' : 'text-foreground hover:bg-muted hover:text-foreground',
      ].join(' ')}
      onClick={handleWorkspaceClick}
    >
      {isActive && (
        <span className="absolute left-0 top-1/2 -translate-y-1/2 h-5 w-0.5 rounded-full bg-primary" />
      )}

      <div className="relative shrink-0">
        <Folder size={14} className="text-muted-foreground" />
        {sessionStatus === 'running' && (
          <span className="absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full bg-primary animate-pulse" />
        )}
        {sessionStatus === 'idle' && sessionId && (
          <span className="absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full bg-success" />
        )}
        {sessionStatus === 'error' && (
          <span className="absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full bg-error" />
        )}
      </div>

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
