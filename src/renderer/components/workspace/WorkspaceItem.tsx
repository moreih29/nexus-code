import { Folder, Settings2, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useStore } from 'zustand'
import type { WorkspaceEntry } from '../../../shared/types'
import { useWorkspaceStore } from '../../stores/workspace-store'
import { getOrCreateWorkspaceStore, setActiveStore } from '../../stores/session-store'
import { useRightPanelUIStore } from '../../stores/plugin-store'
import { useSettingsStore } from '../../stores/settings-store'
import { useToast } from '../ui/toast'
import { cn } from '../../lib/utils'

interface WorkspaceItemProps {
  workspace: WorkspaceEntry
  onOpenWorkspaceSettings?: (workspacePath: string) => void
}

function shortenPath(path: string): string {
  return path.replace(/^\/Users\/[^/]+\//, '~/')
}

export function WorkspaceItem({ workspace, onOpenWorkspaceSettings }: WorkspaceItemProps) {
  const { activeWorkspace, setActiveWorkspace, removeWorkspace } = useWorkspaceStore()
  const showToast = useToast()
  const [removed, setRemoved] = useState(false)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const contextMenuRef = useRef<HTMLDivElement>(null)

  const isActive = activeWorkspace === workspace.path

  const workspaceStore = getOrCreateWorkspaceStore(workspace.path)
  const sessionStatus = useStore(workspaceStore, (s) => s.status)
  const sessionId = useStore(workspaceStore, (s) => s.sessionId)

  useEffect(() => {
    if (!contextMenu) return
    const handleClick = (e: MouseEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        setContextMenu(null)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [contextMenu])

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

    // 워크스페이스 설정 재로드
    await useSettingsStore.getState().initialize(workspace.path)
  }

  const handleRemove = (): void => {
    setContextMenu(null)

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

  const handleContextMenu = (e: React.MouseEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({ x: e.clientX, y: e.clientY })
  }

  const handleSettingsClick = (e: React.MouseEvent): void => {
    e.stopPropagation()
    setContextMenu(null)
    onOpenWorkspaceSettings?.(workspace.path)
  }

  return (
    <>
      <div
        className={cn(
          'group relative flex w-full items-center gap-1 rounded-md px-2 py-2 text-left transition-colors cursor-pointer',
          isActive ? 'bg-primary/15 text-foreground' : 'text-foreground hover:bg-muted hover:text-foreground',
        )}
        onClick={handleWorkspaceClick}
        onContextMenu={handleContextMenu}
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

        {onOpenWorkspaceSettings && (
          <button
            className={cn(
              'shrink-0 rounded p-0.5 transition-opacity hover:bg-muted-foreground/20',
              isActive ? 'opacity-60 hover:opacity-100' : 'opacity-0 group-hover:opacity-100',
            )}
            onClick={handleSettingsClick}
            title="워크스페이스 설정"
          >
            <Settings2 size={12} className="text-muted-foreground" />
          </button>
        )}
      </div>

      {/* 우클릭 컨텍스트 메뉴 */}
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="fixed z-[100] min-w-[140px] overflow-hidden rounded-lg border border-border bg-popover py-1 shadow-xl"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          {onOpenWorkspaceSettings && (
            <button
              className="flex w-full items-center gap-2 px-3 py-1.5 text-sm text-foreground hover:bg-accent"
              onClick={handleSettingsClick}
            >
              <Settings2 size={14} />
              설정
            </button>
          )}
          <button
            className="flex w-full items-center gap-2 px-3 py-1.5 text-sm text-error hover:bg-accent"
            onClick={handleRemove}
          >
            <Trash2 size={14} />
            삭제
          </button>
        </div>
      )}
    </>
  )
}
