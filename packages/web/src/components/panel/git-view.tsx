import { usePanelStore } from '../../stores/panel-store'

interface DiffLine {
  type: 'ctx' | 'add' | 'del'
  ln: string
  text: string
}

const mockDiffLines: DiffLine[] = [
  { type: 'ctx', ln: '14', text: '<div className="ws-card-meta">' },
  { type: 'add', ln: '', text: '+ <span className="ws-branch">' },
  { type: 'add', ln: '', text: '+   <GitBranchIcon size={12} />' },
  { type: 'add', ln: '', text: "+   {workspace.gitBranch ?? 'main'}" },
  { type: 'add', ln: '', text: '+ </span>' },
  { type: 'ctx', ln: '15', text: '<span className="ws-path">' },
]

export function GitView() {
  const { gitChanges, gitCommits } = usePanelStore()

  const staged = gitChanges.filter((c) => c.staged)
  const unstaged = gitChanges.filter((c) => !c.staged)

  return (
    <div className="flex flex-col flex-1 overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center px-3 py-2 gap-2 border-b border-border-light text-[11px] text-text-secondary">
        <span className="font-medium text-text-primary">feat/ui-redesign</span>
        <span className="flex-1 text-[10px] text-text-muted ml-1">↑2 ↓0</span>
        <button className="hover:text-text-primary hover:bg-bg-hover px-1.5 py-0.5 rounded transition-colors">
          ↻
        </button>
        <button className="hover:text-text-primary hover:bg-bg-hover px-1.5 py-0.5 rounded transition-colors">
          ⤢
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
                  key={change.path}
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
        {unstaged.length > 0 && (
          <>
            <div className="px-3.5 pt-2.5 pb-1.5 text-[11px] font-semibold text-text-secondary uppercase tracking-[0.3px]">
              Changes ({unstaged.length})
            </div>
            <div className="px-2">
              {unstaged.map((change) => (
                <div
                  key={change.path}
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

        {/* Diff preview */}
        <div className="mx-3 my-2 bg-bg-base border border-border rounded overflow-hidden font-mono text-[11px]">
          <div className="flex justify-between items-center px-2.5 py-1.5 bg-bg-elevated border-b border-border text-text-secondary">
            <span>workspace-card.tsx</span>
            <span>
              <span className="text-[#3fb950]">+12</span>{' '}
              <span className="text-[#f85149]">-3</span>
            </span>
          </div>
          <div className="py-1 max-h-[200px] overflow-y-auto">
            {mockDiffLines.map((line, i) => (
              <div
                key={i}
                className={[
                  'flex gap-2 px-2.5 py-px text-[11px] leading-[1.5]',
                  line.type === 'add' ? 'bg-[rgba(63,185,80,0.1)] text-[#3fb950]' : '',
                  line.type === 'del' ? 'bg-[rgba(248,81,73,0.1)] text-[#f85149]' : '',
                  line.type === 'ctx' ? 'text-text-muted' : '',
                ].join(' ')}
              >
                <span className="w-7 text-right text-text-muted flex-shrink-0">{line.ln}</span>
                <span>{line.text}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Recent commits */}
        <div className="px-3.5 pt-2.5 pb-1.5 text-[11px] font-semibold text-text-secondary uppercase tracking-[0.3px]">
          Recent Commits
        </div>
        <div className="px-2 pb-2">
          {gitCommits.map((commit) => (
            <div
              key={commit.hash}
              className="flex flex-col gap-0.5 px-2 py-2 rounded cursor-pointer hover:bg-bg-hover"
            >
              <span className="text-[12px] text-text-primary">{commit.message}</span>
              <span className="text-[10px] text-text-muted">
                {commit.timeAgo} · {commit.hash}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Commit input area */}
      <div className="p-3 border-t border-border mt-auto">
        <textarea
          className="w-full bg-bg-base border border-border rounded px-2.5 py-2 text-text-primary text-[12px] font-sans resize-none outline-none placeholder:text-text-muted focus:border-[#58a6ff] transition-colors"
          placeholder="커밋 메시지..."
          rows={2}
        />
        <button className="mt-2 w-full py-1.5 bg-[#58a6ff] border-none text-white rounded text-[12px] font-medium cursor-pointer hover:opacity-85 transition-opacity">
          Commit &amp; Push
        </button>
      </div>
    </div>
  )
}
