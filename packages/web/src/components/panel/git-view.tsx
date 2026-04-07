import { useWorkspaceStore } from '../../stores/workspace-store'
import { useWorkspaces, useGitInfo } from '../../hooks/use-workspaces'

export function GitView() {
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)
  const { data: workspaces } = useWorkspaces()
  const activeWorkspace = workspaces?.find((ws) => ws.id === activeWorkspaceId)
  const workspacePath = activeWorkspace?.path ?? null

  const { data: gitData, isLoading } = useGitInfo(workspacePath)

  const isError = gitData && 'error' in gitData
  const info = gitData && !('error' in gitData) ? gitData : null

  const branch = info?.branch ?? ''
  const staged = info?.staged ?? []
  const changes = info?.changes ?? []
  const commits = info?.commits ?? []

  if (isLoading) {
    return (
      <div className="flex flex-col flex-1 overflow-hidden items-center justify-center">
        <span className="text-[12px] text-text-muted">불러오는 중...</span>
      </div>
    )
  }

  if (!workspacePath) {
    return (
      <div className="flex flex-col flex-1 overflow-hidden items-center justify-center">
        <span className="text-[12px] text-text-muted">워크스페이스를 선택하세요</span>
      </div>
    )
  }

  if (isError) {
    return (
      <div className="flex flex-col flex-1 overflow-hidden items-center justify-center gap-1">
        <span className="text-[12px] text-text-muted">Git 저장소가 아닙니다</span>
        <span className="text-[11px] text-text-muted opacity-60">{workspacePath}</span>
      </div>
    )
  }

  return (
    <div className="flex flex-col flex-1 overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center px-3 py-2 gap-2 border-b border-border-light text-[11px] text-text-secondary">
        <span className="font-medium text-text-primary">{branch || '—'}</span>
        <span className="flex-1 text-[10px] text-text-muted ml-1" />
        <button className="hover:text-text-primary hover:bg-bg-hover px-1.5 py-0.5 rounded transition-colors">
          ↻
        </button>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto">
        {/* Staged */}
        {staged.length > 0 && (
          <>
            <div className="px-3.5 pt-2.5 pb-1.5 text-[11px] font-semibold text-text-secondary uppercase tracking-[0.3px]">
              Staged ({staged.length})
            </div>
            <div className="px-2">
              {staged.map((change) => (
                <div
                  key={`staged-${change.path}`}
                  className="flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer text-[12px] text-text-secondary hover:bg-bg-hover hover:text-text-primary"
                >
                  <span
                    className={[
                      'text-[11px] font-bold w-4 text-center',
                      change.status === 'M' ? 'text-[#d29922]' : '',
                      change.status === 'A' ? 'text-[#3fb950]' : '',
                      change.status === 'D' ? 'text-[#f85149]' : '',
                    ].join(' ')}
                  >
                    {change.status}
                  </span>
                  <span className="flex-1 truncate">{change.path}</span>
                  <span className="text-[10px] font-mono">
                    <span className="text-[#3fb950]">+{change.additions}</span>{' '}
                    <span className="text-[#f85149]">-{change.deletions}</span>
                  </span>
                </div>
              ))}
            </div>
          </>
        )}

        {/* Changes (unstaged) */}
        {changes.length > 0 && (
          <>
            <div className="px-3.5 pt-2.5 pb-1.5 text-[11px] font-semibold text-text-secondary uppercase tracking-[0.3px]">
              Changes ({changes.length})
            </div>
            <div className="px-2">
              {changes.map((change) => (
                <div
                  key={`changes-${change.path}`}
                  className="flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer text-[12px] text-text-secondary hover:bg-bg-hover hover:text-text-primary"
                >
                  <span
                    className={[
                      'text-[11px] font-bold w-4 text-center',
                      change.status === 'M' ? 'text-[#d29922]' : '',
                      change.status === 'A' ? 'text-[#3fb950]' : '',
                      change.status === 'D' ? 'text-[#f85149]' : '',
                    ].join(' ')}
                  >
                    {change.status}
                  </span>
                  <span className="flex-1 truncate">{change.path}</span>
                  <span className="text-[10px] font-mono">
                    <span className="text-[#3fb950]">+{change.additions}</span>{' '}
                    <span className="text-[#f85149]">-{change.deletions}</span>
                  </span>
                </div>
              ))}
            </div>
          </>
        )}

        {staged.length === 0 && changes.length === 0 && (
          <div className="px-3.5 pt-3 text-[12px] text-text-muted">변경 사항 없음</div>
        )}

        {/* Recent commits */}
        {commits.length > 0 && (
          <>
            <div className="px-3.5 pt-2.5 pb-1.5 text-[11px] font-semibold text-text-secondary uppercase tracking-[0.3px]">
              Recent Commits
            </div>
            <div className="px-2 pb-2">
              {commits.map((commit) => (
                <div
                  key={commit.hash}
                  className="flex flex-col gap-0.5 px-2 py-2 rounded cursor-pointer hover:bg-bg-hover"
                >
                  <span className="text-[12px] text-text-primary">{commit.message}</span>
                  <span className="text-[10px] text-text-muted">
                    {commit.date} · {commit.hash}
                  </span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {/* Commit input area — placeholder only */}
      <div className="p-3 border-t border-border mt-auto">
        <textarea
          className="w-full bg-bg-base border border-border rounded px-2.5 py-2 text-text-primary text-[12px] font-sans resize-none outline-none placeholder:text-text-muted focus:border-[#58a6ff] transition-colors"
          placeholder="커밋 메시지..."
          rows={2}
          disabled
        />
        <button
          className="mt-2 w-full py-1.5 bg-[#58a6ff] border-none text-white rounded text-[12px] font-medium cursor-not-allowed opacity-40 transition-opacity"
          disabled
        >
          Commit &amp; Push
        </button>
      </div>
    </div>
  )
}
