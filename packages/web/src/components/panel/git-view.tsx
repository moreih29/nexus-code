import { useState } from 'react'
import { useWorkspaceStore } from '../../stores/workspace-store'
import { useWorkspaces, useGitInfo } from '../../hooks/use-workspaces'
import { fetchGitDiff, fetchGitShow } from '../../api/workspace'
import type { GitDiffResponse, GitShowResponse } from '../../api/workspace'

type DiffView = {
  kind: 'diff'
  file: string
  staged: boolean
  data: GitDiffResponse | null
  loading: boolean
}

type ShowView = {
  kind: 'show'
  hash: string
  data: GitShowResponse | null
  loading: boolean
}

type DetailView = DiffView | ShowView

export function GitView() {
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)
  const { data: workspaces } = useWorkspaces()
  const activeWorkspace = workspaces?.find((ws) => ws.id === activeWorkspaceId)
  const workspacePath = activeWorkspace?.path ?? null

  const { data: gitData, isLoading } = useGitInfo(workspacePath)

  const [detail, setDetail] = useState<DetailView | null>(null)

  const isError = gitData && 'error' in gitData
  const info = gitData && !('error' in gitData) ? gitData : null

  const branch = info?.branch ?? ''
  const staged = info?.staged ?? []
  const changes = info?.changes ?? []
  const commits = info?.commits ?? []

  async function openDiff(file: string, isStagedDiff: boolean) {
    if (!workspacePath) return
    const view: DiffView = { kind: 'diff', file, staged: isStagedDiff, data: null, loading: true }
    setDetail(view)
    try {
      const data = await fetchGitDiff(workspacePath, file, isStagedDiff)
      setDetail((prev) => (prev?.kind === 'diff' && prev.file === file ? { ...view, data, loading: false } : prev))
    } catch {
      setDetail((prev) => (prev?.kind === 'diff' && prev.file === file ? { ...view, data: { diff: '' }, loading: false } : prev))
    }
  }

  async function openShow(hash: string) {
    if (!workspacePath) return
    const view: ShowView = { kind: 'show', hash, data: null, loading: true }
    setDetail(view)
    try {
      const data = await fetchGitShow(workspacePath, hash)
      setDetail((prev) => (prev?.kind === 'show' && prev.hash === hash ? { ...view, data, loading: false } : prev))
    } catch {
      setDetail((prev) => (prev?.kind === 'show' && prev.hash === hash ? { ...view, data: { message: '', files: [], stat: '' }, loading: false } : prev))
    }
  }

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

  if (detail) {
    return (
      <div className="flex flex-col flex-1 overflow-hidden">
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border-light">
          <button
            onClick={() => setDetail(null)}
            className="text-[11px] text-text-secondary hover:text-text-primary px-1.5 py-0.5 rounded hover:bg-bg-hover transition-colors"
          >
            ← 뒤로
          </button>
          <span className="text-[11px] text-text-muted truncate">
            {detail.kind === 'diff'
              ? `${detail.staged ? '[staged] ' : ''}${detail.file}`
              : detail.hash}
          </span>
        </div>

        {detail.loading ? (
          <div className="flex flex-1 items-center justify-center">
            <span className="text-[12px] text-text-muted">불러오는 중...</span>
          </div>
        ) : detail.kind === 'diff' ? (
          <DiffViewer diff={detail.data?.diff ?? ''} />
        ) : (
          <ShowViewer data={detail.data} />
        )}
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
                  onClick={() => void openDiff(change.path, true)}
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
                  onClick={() => void openDiff(change.path, false)}
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
                  onClick={() => void openShow(commit.hash)}
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

function DiffViewer({ diff }: { diff: string }) {
  if (!diff) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <span className="text-[12px] text-text-muted">diff 없음</span>
      </div>
    )
  }

  const lines = diff.split('\n')

  return (
    <div className="flex-1 overflow-auto">
      <pre className="text-[11px] font-mono leading-5 px-3 py-2 min-w-0">
        {lines.map((line, i) => {
          let colorClass = 'text-text-secondary'
          if (line.startsWith('+') && !line.startsWith('+++')) colorClass = 'text-[#3fb950]'
          else if (line.startsWith('-') && !line.startsWith('---')) colorClass = 'text-[#f85149]'
          else if (line.startsWith('@@')) colorClass = 'text-[#58a6ff]'
          else if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')) colorClass = 'text-text-muted'

          return (
            <div key={i} className={colorClass}>
              {line || ' '}
            </div>
          )
        })}
      </pre>
    </div>
  )
}

function ShowViewer({ data }: { data: GitShowResponse | null }) {
  if (!data || (!data.message && data.files.length === 0)) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <span className="text-[12px] text-text-muted">정보 없음</span>
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto px-3 py-2">
      {data.message && (
        <div className="mb-3">
          <div className="text-[11px] font-semibold text-text-secondary uppercase tracking-[0.3px] mb-1">
            Message
          </div>
          <pre className="text-[12px] text-text-primary font-sans whitespace-pre-wrap">{data.message.trim()}</pre>
        </div>
      )}
      {data.files.length > 0 && (
        <div>
          <div className="text-[11px] font-semibold text-text-secondary uppercase tracking-[0.3px] mb-1">
            Changed Files ({data.files.length})
          </div>
          <div className="flex flex-col gap-0.5">
            {data.files.map((f, i) => (
              <span key={i} className="text-[12px] text-text-primary font-mono truncate">
                {f}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
