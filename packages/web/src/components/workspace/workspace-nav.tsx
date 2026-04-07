import { useEffect } from 'react'
import { useWorkspaceStore } from '../../stores/workspace-store'
import { WorkspaceCard } from './workspace-card'
import { selectFolder } from '../../lib/electron'
import { useCreateWorkspace } from '../../hooks/use-workspaces'

export function WorkspaceNav() {
  const { workspaces, activeWorkspaceId, setActiveWorkspace, setActiveByIndex, addMockWorkspace } =
    useWorkspaceStore()
  const createWorkspace = useCreateWorkspace()

  async function handleAddWorkspace() {
    const folderPath = await selectFolder()
    if (!folderPath) return

    const name = folderPath.split('/').filter(Boolean).pop() ?? folderPath

    console.log('[WorkspaceNav] 워크스페이스 추가:', { path: folderPath, name })

    try {
      await createWorkspace.mutateAsync({ path: folderPath, name })
    } catch (err) {
      console.error('[WorkspaceNav] 서버 등록 실패, 목업 스토어에 추가:', err)
      addMockWorkspace({ path: folderPath, name })
    }
  }

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (!e.metaKey) return
      const digit = parseInt(e.key, 10)
      if (digit >= 1 && digit <= 9) {
        e.preventDefault()
        setActiveByIndex(digit - 1)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [setActiveByIndex])

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
            isActive={ws.id === activeWorkspaceId}
            onClick={() => setActiveWorkspace(ws.id)}
          />
        ))}
      </div>
    </div>
  )
}
