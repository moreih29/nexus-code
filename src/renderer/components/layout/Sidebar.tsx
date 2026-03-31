import { memo } from 'react'
import { PanelLeft, Settings } from 'lucide-react'
import { useStore } from 'zustand'
import type { WorkspaceEntry } from '../../../shared/types'
import { cn } from '../../lib/utils'
import { WorkspaceList } from '../workspace/WorkspaceList'
import { useWorkspaceStore } from '../../stores/workspace-store'
import { getOrCreateWorkspaceStore, setActiveStore } from '../../stores/session-store'
import { useRightPanelUIStore } from '../../stores/plugin-store'
import { useSettingsStore } from '../../stores/settings-store'

interface SidebarProps {
  onToggle?: () => void
  isCollapsed?: boolean
  onOpenSettings?: () => void
  onOpenWorkspaceSettings?: () => void
}

function CollapsedWorkspaceButton({ workspace, activeWorkspace }: {
  workspace: WorkspaceEntry
  activeWorkspace: string | null
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
      {sessionStatus === 'error' && (
        <span className="absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full bg-error" />
      )}
    </button>
  )
}

export const Sidebar = memo(function Sidebar({ onToggle, isCollapsed, onOpenSettings, onOpenWorkspaceSettings }: SidebarProps) {
  const workspaces = useWorkspaceStore((s) => s.workspaces)
  const activeWorkspace = useWorkspaceStore((s) => s.activeWorkspace)

  return (
    <>
      {/* 접힌 상태: 아이콘 스트립 */}
      {isCollapsed && (
        <aside className="flex h-full w-full flex-col items-center border-r border-border bg-card py-2">
          <button
            onClick={onToggle}
            className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            title="사이드바 열기"
          >
            <PanelLeft size={18} />
          </button>
          <div className="mx-2 my-1 h-px w-6 bg-border" />
          <div className="flex flex-col items-center gap-1 px-1">
            {workspaces.map((ws) => (
              <CollapsedWorkspaceButton
                key={ws.path}
                workspace={ws}
                activeWorkspace={activeWorkspace}
              />
            ))}
          </div>
          <div className="flex-1" />
          <button
            onClick={onOpenSettings}
            className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            title="설정"
          >
            <Settings size={18} />
          </button>
        </aside>
      )}

      {/* 펼친 상태: WorkspaceList는 항상 마운트, display로 숨김 */}
      <aside className="flex h-full flex-col border-r border-border bg-card" style={{ display: isCollapsed ? 'none' : undefined }}>
        <div className="flex h-12 items-center justify-between border-b border-border px-4">
          <div className="flex items-center gap-2">
            <span className="text-sm font-bold tracking-tight text-primary">Nexus</span>
            <span className="text-[10px] font-medium text-dim-foreground">Code</span>
          </div>
          <button
            onClick={onOpenSettings}
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            title="설정"
          >
            <Settings size={16} />
          </button>
        </div>
        <div className="min-h-0 flex-1">
          <WorkspaceList onOpenWorkspaceSettings={onOpenWorkspaceSettings} />
        </div>
      </aside>
    </>
  )
})
