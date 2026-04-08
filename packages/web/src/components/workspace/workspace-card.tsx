import { useDeleteWorkspace } from '../../hooks/use-workspaces'

export interface DisplayWorkspace {
  id: string
  name: string
  path: string
  gitBranch: string
  model: string
  status: 'active' | 'idle' | 'warning'
  activeSubagents: number
  totalSubagents: number
  pendingApprovals: number
}

interface WorkspaceCardProps {
  workspace: DisplayWorkspace
  isActive: boolean
  onClick: () => void
}

function StatusDot({ status }: { status: DisplayWorkspace['status'] }) {
  if (status === 'active') {
    return (
      <span
        className="w-2 h-2 rounded-full flex-shrink-0 bg-green"
        style={{ boxShadow: '0 0 6px var(--green)' }}
      />
    )
  }
  if (status === 'warning') {
    return (
      <span
        className="w-2 h-2 rounded-full flex-shrink-0 bg-yellow"
        style={{ boxShadow: '0 0 6px var(--yellow)' }}
      />
    )
  }
  return <span className="w-2 h-2 rounded-full flex-shrink-0 bg-text-muted" />
}

function GitBranchIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
      <path d="M11.75 2.5a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0zm.75 2.75a2.25 2.25 0 1 1 0-4.5 2.25 2.25 0 0 1 0 4.5zM4.25 13.5a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0zm.75 2.25a2.25 2.25 0 1 1 0-4.5 2.25 2.25 0 0 1 0 4.5zm0-13.5a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0zm.75 2.25a2.25 2.25 0 1 1 0-4.5 2.25 2.25 0 0 1 0 4.5zM5 5.372v5.256a3.75 3.75 0 1 0 1.5 0V8.75A2.25 2.25 0 0 0 8.75 6.5h1.878a3.75 3.75 0 1 0 0-1.5H8.75A.75.75 0 0 1 8 4.25V2.628a3.751 3.751 0 1 0-1.5 0v2.744z" />
    </svg>
  )
}

export function WorkspaceCard({ workspace, isActive, onClick }: WorkspaceCardProps) {
  const deleteWorkspace = useDeleteWorkspace()

  function handleDelete(e: React.MouseEvent) {
    e.stopPropagation()
    if (!window.confirm(`"${workspace.name}" 워크스페이스를 삭제하시겠습니까?`)) return
    deleteWorkspace.mutate(workspace.path)
  }

  return (
    <div
      className={[
        'group px-3 py-2.5 rounded-md cursor-pointer mb-1 transition-colors relative',
        isActive ? 'bg-bg-active' : 'hover:bg-bg-hover',
      ].join(' ')}
      onClick={onClick}
    >
      {/* Header row: status dot + name + pending badge + delete button */}
      <div className="flex items-center gap-2 mb-1.5">
        <StatusDot status={workspace.status} />
        <span className="text-[13px] font-semibold flex-1 truncate text-text-primary">
          {workspace.name}
        </span>
        {workspace.pendingApprovals > 0 && (
          <span className="bg-red text-white text-[10px] font-semibold px-1.5 py-px rounded-full leading-none">
            {workspace.pendingApprovals}
          </span>
        )}
        <button
          onClick={handleDelete}
          className="opacity-0 group-hover:opacity-100 text-text-muted hover:text-red text-[13px] leading-none transition-opacity ml-1"
          title="워크스페이스 삭제"
        >
          ×
        </button>
      </div>

      {/* Branch row */}
      <div className="flex items-center gap-1.5 text-[11px] text-text-secondary">
        <GitBranchIcon />
        <span>{workspace.gitBranch}</span>
      </div>

      {/* Path row */}
      <div className="text-[10px] text-text-muted mt-1 truncate">{workspace.path}</div>

      {/* Session info row */}
      <div className="flex items-center gap-1.5 mt-1.5 pt-1.5 border-t border-border-light text-[10px] text-text-muted">
        <span className="bg-bg-elevated border border-border px-1.5 py-px rounded-full text-[9px] text-text-secondary">
          {workspace.model}
        </span>
        {workspace.totalSubagents > 0 && (
          <span>
            {workspace.activeSubagents}/{workspace.totalSubagents} 에이전트
          </span>
        )}
      </div>
    </div>
  )
}
