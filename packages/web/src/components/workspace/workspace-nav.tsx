import { useEffect } from 'react'
import { useWorkspaceStore } from '../../stores/workspace-store'
import { WorkspaceCard, type DisplayWorkspace } from './workspace-card'
import { selectFolder } from '../../lib/electron'
import { useWorkspaces, useCreateWorkspace } from '../../hooks/use-workspaces'
import type { WorkspaceResponse } from '@nexus/shared'

function toDisplayWorkspace(ws: WorkspaceResponse): DisplayWorkspace {
  return {
    id: ws.id,
    name: ws.name ?? ws.path.split('/').filter(Boolean).pop() ?? ws.path,
    path: ws.path,
    gitBranch: 'main',
    model: 'sonnet-4',
    status: 'idle',
    activeSubagents: 0,
    totalSubagents: 0,
    pendingApprovals: 0,
  }
}

export function WorkspaceNav() {
  const { activeWorkspaceId, setActiveWorkspace, setActiveByIndex } = useWorkspaceStore()
  const { data: serverWorkspaces, isError } = useWorkspaces()
  const createWorkspace = useCreateWorkspace()

  const workspaces: DisplayWorkspace[] =
    serverWorkspaces && !isError ? serverWorkspaces.map(toDisplayWorkspace) : []

  const workspaceIds = workspaces.map((ws) => ws.id)

  const resolvedActiveId =
    activeWorkspaceId !== null && workspaces.some((ws) => ws.id === activeWorkspaceId)
      ? activeWorkspaceId
      : (workspaces[0]?.id ?? null)

  async function handleAddWorkspace() {
    const folderPath = await selectFolder()
    if (!folderPath) return

    const name = folderPath.split('/').filter(Boolean).pop() ?? folderPath

    console.log('[WorkspaceNav] 워크스페이스 추가:', { path: folderPath, name })

    try {
      await createWorkspace.mutateAsync({ path: folderPath, name })
    } catch (err) {
      console.error('[WorkspaceNav] 서버 등록 실패:', err)
    }
  }

  // 워크스페이스 로드 시 첫 번째 자동 선택
  useEffect(() => {
    if (resolvedActiveId && activeWorkspaceId !== resolvedActiveId) {
      setActiveWorkspace(resolvedActiveId)
    }
  }, [resolvedActiveId, activeWorkspaceId, setActiveWorkspace])

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (!e.metaKey) return
      const digit = parseInt(e.key, 10)
      if (digit >= 1 && digit <= 9) {
        e.preventDefault()
        setActiveByIndex(digit - 1, workspaceIds)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [setActiveByIndex, workspaceIds])

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border-light">
        <span className="text-[11px] font-semibold text-text-secondary uppercase tracking-wide">
          Workspaces
        </span>
        <button
          onClick={() => void handleAddWorkspace()}
          className="text-text-secondary hover:text-text-primary hover:bg-bg-hover rounded px-1 text-base leading-none transition-colors"
        >
          +
        </button>
      </div>

      {/* Workspace list */}
      <div className="flex-1 overflow-y-auto p-2">
        {workspaces.map((ws) => (
          <WorkspaceCard
            key={ws.id}
            workspace={ws}
            isActive={ws.id === resolvedActiveId}
            onClick={() => setActiveWorkspace(ws.id)}
          />
        ))}
      </div>
    </div>
  )
}
