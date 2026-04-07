import type { MockWorkspace } from '../../mock/data'

interface WorkspaceCardProps {
  workspace: MockWorkspace
  isActive: boolean
  onClick: () => void
}

function StatusDot({ status }: { status: MockWorkspace['status'] }) {
  if (status === 'active') {
    return (
      <span
        className="w-2 h-2 rounded-full flex-shrink-0 bg-[#3fb950]"
        style={{ boxShadow: '0 0 6px #3fb950' }}
      />
    )
  }
  if (status === 'warning') {
    return (
      <span
        className="w-2 h-2 rounded-full flex-shrink-0 bg-[#d29922]"
        style={{ boxShadow: '0 0 6px #d29922' }}
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
  return (
    <div
      className={[
        'px-3 py-2.5 rounded-md cursor-pointer mb-1 transition-colors',
        isActive ? 'bg-bg-active' : 'hover:bg-bg-hover',
      ].join(' ')}
      onClick={onClick}
    >
      {/* Header row: status dot + name + pending badge */}
      <div className="flex items-center gap-2 mb-1.5">
        <StatusDot status={workspace.status} />
        <span className="text-[13px] font-semibold flex-1 truncate text-text-primary">
          {workspace.name}
        </span>
        {workspace.pendingApprovals > 0 && (
          <span className="bg-[#f85149] text-white text-[10px] font-semibold px-1.5 py-px rounded-full leading-none ml-auto">
            {workspace.pendingApprovals}
          </span>
        )}
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
