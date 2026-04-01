import { memo } from 'react'
import { Plus, FolderOpen, Users, Settings } from 'lucide-react'
import { useStore } from 'zustand'
import type { WorkspaceEntry } from '../../../shared/types'
import { cn } from '../../lib/utils'
import { useWorkspaceStore } from '../../stores/workspace-store'
import { getOrCreateWorkspaceStore, setActiveStore } from '../../stores/session-store'
import { useRightPanelUIStore } from '../../stores/plugin-store'
import { useSettingsStore } from '../../stores/settings-store'
import type { FlyoutContentType } from './FlyoutPanel'

interface ActivityBarProps {
  activeFlyout: FlyoutContentType | null
  onFlyoutToggle: (type: FlyoutContentType) => void
}

// ─── 워크스페이스 버튼 ────────────────────────────────────────────────────────

function WorkspaceButton({
  workspace,
  activeWorkspace,
  onHover,
}: {
  workspace: WorkspaceEntry
  activeWorkspace: string | null
  onHover: () => void
}) {
  const workspaceStore = getOrCreateWorkspaceStore(workspace.path)
  const sessionStatus = useStore(workspaceStore, (s) => s.status)
  const sessionId = useStore(workspaceStore, (s) => s.sessionId)
  const setActiveWorkspace = useWorkspaceStore((s) => s.setActiveWorkspace)

  const handleClick = async (): Promise<void> => {
    if (activeWorkspace === workspace.path) return
    useRightPanelUIStore.getState().cleanup()
    setActiveWorkspace(workspace.path)
    const store = getOrCreateWorkspaceStore(workspace.path)
    setActiveStore(store)
    if (workspace.sessionId && !store.getState().sessionId) {
      await store.getState().restoreSession(workspace.sessionId)
    }
    await useSettingsStore.getState().initialize(workspace.path)
  }

  return (
    <button
      onClick={() => void handleClick()}
      onMouseEnter={onHover}
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
    </button>
  )
}

// ─── ActivityBar ─────────────────────────────────────────────────────────────

export const ActivityBar = memo(function ActivityBar({ activeFlyout, onFlyoutToggle }: ActivityBarProps) {
  const workspaces = useWorkspaceStore((s) => s.workspaces)
  const activeWorkspace = useWorkspaceStore((s) => s.activeWorkspace)
  const addWorkspace = useWorkspaceStore((s) => s.addWorkspace)

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
          />
        ))}

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
