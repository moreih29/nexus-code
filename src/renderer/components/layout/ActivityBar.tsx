import { memo } from 'react'
import { Plus, FolderOpen, Users, Settings } from 'lucide-react'
import { useStore } from 'zustand'
import type { WorkspaceEntry } from '../../../shared/types'
import { cn } from '../../lib/utils'
import { useWorkspaceStore } from '../../stores/workspace-store'
import { getOrCreateWorkspaceStore, setActiveStore } from '../../stores/session-store'
import { useRightPanelUIStore } from '../../stores/plugin-store'
import { useSettingsStore } from '../../stores/settings-store'
import { useNotificationStore } from '../../stores/notification-store'
import type { FlyoutContentType } from './FlyoutPanel'

interface ActivityBarProps {
  activeFlyout: FlyoutContentType | null
  onFlyoutToggle: (type: FlyoutContentType) => void
  /** HTML5 drag data type (AppLayout에서 지정) */
  dragDataType?: string
}

// ─── 워크스페이스 버튼 ────────────────────────────────────────────────────────

function WorkspaceButton({
  workspace,
  activeWorkspace,
  onHover,
  dragDataType,
}: {
  workspace: WorkspaceEntry
  activeWorkspace: string | null
  onHover: () => void
  dragDataType?: string
}) {
  const workspaceStore = getOrCreateWorkspaceStore(workspace.path)
  const sessionStatus = useStore(workspaceStore, (s) => s.status)
  const sessionId = useStore(workspaceStore, (s) => s.sessionId)
  const setActiveWorkspace = useWorkspaceStore((s) => s.setActiveWorkspace)
  const unreadCount = useNotificationStore((s) => s.getUnreadCount(workspace.path))

  const handleClick = async (): Promise<void> => {
    if (activeWorkspace === workspace.path) return
    useRightPanelUIStore.getState().cleanup()
    // 전환 시 배지 리셋
    useNotificationStore.getState().resetUnread(workspace.path)
    setActiveWorkspace(workspace.path)
    const store = getOrCreateWorkspaceStore(workspace.path)
    setActiveStore(store)
    if (workspace.sessionId && !store.getState().sessionId) {
      await store.getState().restoreSession(workspace.sessionId)
    }
    await useSettingsStore.getState().initialize(workspace.path)
  }

  const handleDragStart = (e: React.DragEvent<HTMLButtonElement>) => {
    const dtype = dragDataType ?? 'application/nexus-workspace-path'
    e.dataTransfer.setData(dtype, workspace.path)
    e.dataTransfer.effectAllowed = 'move'
  }

  return (
    <button
      draggable
      onClick={() => void handleClick()}
      onMouseEnter={onHover}
      onDragStart={handleDragStart}
      className={cn(
        'relative flex h-8 w-8 items-center justify-center rounded-md text-xs font-semibold transition-colors',
        workspace.path === activeWorkspace
          ? 'bg-primary/15 text-primary'
          : 'text-muted-foreground hover:bg-muted hover:text-foreground',
      )}
      title={workspace.name}
    >
      {workspace.name.charAt(0).toUpperCase()}
      {sessionStatus === 'running' && (
        <span className="absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full bg-primary animate-pulse" />
      )}
      {sessionStatus === 'idle' && sessionId && (
        <span className="absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full bg-success" />
      )}
      {sessionStatus === 'waiting_permission' && (
        <span className="absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full bg-warning" />
      )}
      {sessionStatus === 'error' && (
        <span className="absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full bg-error" />
      )}
      {sessionStatus === 'suspended' && (
        <span className="absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full bg-muted-foreground/30" />
      )}
      {/* 미확인 메시지 배지 */}
      {unreadCount > 0 && workspace.path !== activeWorkspace && (
        <span className="absolute -top-1 -right-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-primary px-0.5 text-[9px] font-bold text-primary-foreground">
          {unreadCount > 9 ? '9+' : unreadCount}
        </span>
      )}
    </button>
  )
}

// ─── ActivityBar ─────────────────────────────────────────────────────────────

const SESSION_SOFT_LIMIT = 5

export const ActivityBar = memo(function ActivityBar({ activeFlyout, onFlyoutToggle, dragDataType }: ActivityBarProps) {
  const workspaces = useWorkspaceStore((s) => s.workspaces)
  const activeWorkspace = useWorkspaceStore((s) => s.activeWorkspace)
  const addWorkspace = useWorkspaceStore((s) => s.addWorkspace)
  const sessionLimitWarned = useNotificationStore((s) => s.sessionLimitWarned)

  // 활성 세션 수 (sessionId가 있는 워크스페이스)
  const activeSessionCount = workspaces.filter((ws) => {
    const store = getOrCreateWorkspaceStore(ws.path)
    return store.getState().sessionId !== null
  }).length

  const showSessionWarning = activeSessionCount >= SESSION_SOFT_LIMIT && !sessionLimitWarned

  const iconButtonCls = (active: boolean) =>
    cn(
      'flex h-8 w-8 items-center justify-center rounded-md transition-colors',
      active
        ? 'bg-primary/15 text-primary'
        : 'text-muted-foreground hover:bg-muted hover:text-foreground',
    )

  return (
    <aside className="flex h-full w-11 flex-shrink-0 flex-col items-center border-r border-border bg-card py-2">
      {/* 로고 */}
      <div className="flex h-8 w-8 items-center justify-center">
        <span className="text-sm font-bold text-primary">N</span>
      </div>

      {/* 구분선 */}
      <div className="mx-2 my-1.5 h-px w-6 bg-border" />

      {/* 워크스페이스 목록 */}
      <div className="flex flex-col items-center gap-1 px-1">
        {workspaces.map((ws) => (
          <WorkspaceButton
            key={ws.path}
            workspace={ws}
            activeWorkspace={activeWorkspace}
            onHover={() => onFlyoutToggle('workspace')}
            dragDataType={dragDataType}
          />
        ))}

        {/* 세션 soft limit 경고 */}
        {showSessionWarning && (
          <button
            onClick={() => useNotificationStore.getState().setSessionLimitWarned(true)}
            className="flex h-5 w-8 items-center justify-center rounded text-[9px] font-medium text-warning bg-warning/15"
            title={`동시 세션 ${activeSessionCount}개 — ${SESSION_SOFT_LIMIT}개 초과 시 메모리 사용량 증가`}
          >
            {activeSessionCount}
          </button>
        )}

        {/* 워크스페이스 추가 */}
        <button
          onClick={() => void addWorkspace()}
          className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
          title="워크스페이스 추가"
        >
          <Plus size={16} />
        </button>
      </div>

      {/* 스페이서 */}
      <div className="flex-1" />

      {/* 구분선 */}
      <div className="mx-2 my-1.5 h-px w-6 bg-border" />

      {/* 하단 아이콘들 */}
      <div className="flex flex-col items-center gap-1 px-1 pb-1">
        <button
          onClick={() => onFlyoutToggle('workspace')}
          className={iconButtonCls(activeFlyout === 'workspace')}
          title="탐색기"
        >
          <FolderOpen size={16} />
        </button>
        <button
          onClick={() => onFlyoutToggle('agents')}
          className={iconButtonCls(activeFlyout === 'agents')}
          title="에이전트"
        >
          <Users size={16} />
        </button>
        <button
          onClick={() => onFlyoutToggle('settings')}
          className={iconButtonCls(activeFlyout === 'settings')}
          title="설정"
        >
          <Settings size={16} />
        </button>
      </div>
    </aside>
  )
})
