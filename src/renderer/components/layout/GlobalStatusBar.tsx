import { useStore } from 'zustand'
import { cn } from '../../lib/utils'
import { useWorkspaceStore } from '../../stores/workspace-store'
import { useSettingsStore } from '../../stores/settings-store'
import { getOrCreateWorkspaceStore, setActiveStore } from '../../stores/session-store'
import { useRightPanelUIStore } from '../../stores/plugin-store'
import type { WorkspaceEntry } from '../../../shared/types'

// ─── 워크스페이스 상태 dot ────────────────────────────────────────────────────

function WorkspaceStatusDot({ workspacePath }: { workspacePath: string }) {
  const store = getOrCreateWorkspaceStore(workspacePath)
  const status = useStore(store, (s) => s.status)
  const sessionId = useStore(store, (s) => s.sessionId)

  if (status === 'running') {
    return <span className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse" />
  }
  if (status === 'idle' && sessionId) {
    return <span className="h-1.5 w-1.5 rounded-full bg-success" />
  }
  if (status === 'waiting_permission') {
    return <span className="h-1.5 w-1.5 rounded-full bg-warning" />
  }
  if (status === 'error') {
    return <span className="h-1.5 w-1.5 rounded-full bg-error" />
  }
  if (status === 'suspended') {
    return <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/30" />
  }
  return null
}

// ─── 워크스페이스 버튼 ────────────────────────────────────────────────────────

function WorkspaceStatusButton({
  workspace,
  isActive,
}: {
  workspace: WorkspaceEntry
  isActive: boolean
}) {
  const setActiveWorkspace = useWorkspaceStore((s) => s.setActiveWorkspace)

  const handleClick = async () => {
    if (isActive) return
    useRightPanelUIStore.getState().cleanup()
    setActiveWorkspace(workspace.path)
    const store = getOrCreateWorkspaceStore(workspace.path)
    setActiveStore(store)
    if (workspace.sessionId && !store.getState().sessionId) {
      await store.getState().restoreSession(workspace.sessionId)
    }
  }

  return (
    <button
      onClick={() => void handleClick()}
      className={cn(
        'flex items-center gap-1.5 rounded px-2 py-0.5 text-xs transition-colors',
        isActive
          ? 'text-foreground'
          : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground',
      )}
      title={workspace.path}
    >
      <WorkspaceStatusDot workspacePath={workspace.path} />
      <span className="max-w-24 truncate">{workspace.name}</span>
    </button>
  )
}

// ─── 토큰 사용량 (조건부 useStore 회피용 컴포넌트) ─────────────────────────────

function TokenDisplay({ workspacePath }: { workspacePath: string }) {
  const store = getOrCreateWorkspaceStore(workspacePath)
  const lastTurnStats = useStore(store, (s) => s.lastTurnStats)
  const totalTokens = lastTurnStats
    ? ((lastTurnStats.inputTokens ?? 0) + (lastTurnStats.outputTokens ?? 0))
    : null

  if (totalTokens === null) return null
  return <span>{(totalTokens / 1000).toFixed(1)}k 토큰</span>
}

// ─── suspended 배지 ───────────────────────────────────────────────────────────

function SuspendedBadge({ workspacePath }: { workspacePath: string }) {
  const store = getOrCreateWorkspaceStore(workspacePath)
  const status = useStore(store, (s) => s.status)
  if (status !== 'suspended') return null
  return (
    <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
      일시정지
    </span>
  )
}

// ─── GlobalStatusBar ──────────────────────────────────────────────────────────

export function GlobalStatusBar() {
  const workspaces = useWorkspaceStore((s) => s.workspaces)
  const activeWorkspace = useWorkspaceStore((s) => s.activeWorkspace)
  const model = useSettingsStore((s) => s.model)

  return (
    <div className="flex h-6 shrink-0 items-center justify-between border-t border-border bg-card px-2">
      {/* 좌측: 워크스페이스 목록 */}
      <div className="flex items-center gap-0.5 overflow-x-auto">
        {workspaces.map((ws) => (
          <WorkspaceStatusButton
            key={ws.path}
            workspace={ws}
            isActive={ws.path === activeWorkspace}
          />
        ))}
      </div>

      {/* 우측: 일시정지 배지 + 모델 + 토큰 */}
      <div className="flex shrink-0 items-center gap-2 text-xs text-dim-foreground">
        {activeWorkspace && <SuspendedBadge workspacePath={activeWorkspace} />}
        {activeWorkspace && <TokenDisplay workspacePath={activeWorkspace} />}
        <span className="text-muted-foreground">{model}</span>
      </div>
    </div>
  )
}
