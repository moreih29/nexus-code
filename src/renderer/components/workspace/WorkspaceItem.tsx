import { useState } from 'react'
import { ChevronRight, Folder } from 'lucide-react'
import type { WorkspaceEntry } from '../../../shared/types'
import { useWorkspaceStore } from '../../stores/workspace-store'
import { useHistoryStore } from '../../stores/history-store'
import { useSessionStore } from '../../stores/session-store'

interface WorkspaceItemProps {
  workspace: WorkspaceEntry
}

function formatRelativeTime(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return '방금 전'
  if (mins < 60) return `${mins}분 전`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}시간 전`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}일 전`
  return new Date(isoDate).toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' })
}

export function WorkspaceItem({ workspace }: WorkspaceItemProps): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const { activeWorkspace, setActiveWorkspace } = useWorkspaceStore()
  const { sessions, activeSessionId, resumeSession } = useHistoryStore()
  const startSession = useSessionStore((s) => s.startSession)
  const resetSession = useSessionStore((s) => s.reset)

  const isActive = activeWorkspace === workspace.path
  const pastSessions = sessions.filter((s) => s.cwd === workspace.path)

  const handleWorkspaceClick = (): void => {
    setActiveWorkspace(workspace.path)
    resetSession()
  }

  const handleToggleExpand = (e: React.MouseEvent): void => {
    e.stopPropagation()
    setExpanded((prev) => !prev)
  }

  const handleSessionClick = async (sessionId: string): Promise<void> => {
    const ok = await resumeSession(sessionId)
    if (ok) {
      startSession(sessionId)
      setActiveWorkspace(workspace.path)
    }
  }

  return (
    <div>
      <div
        className={[
          'flex w-full items-center gap-1 rounded-md px-2 py-2 text-left transition-colors cursor-pointer',
          isActive ? 'bg-blue-900/40 text-gray-100' : 'text-gray-300 hover:bg-gray-800 hover:text-gray-100',
        ].join(' ')}
        onClick={handleWorkspaceClick}
      >
        {/* Expand toggle */}
        <button
          onClick={handleToggleExpand}
          className="shrink-0 rounded p-0.5 hover:bg-gray-700 text-gray-500"
          title="과거 세션 보기"
        >
          <ChevronRight
            size={12}
            className={['transition-transform', expanded ? 'rotate-90' : ''].join(' ')}
          />
        </button>

        <Folder size={14} className="shrink-0 text-gray-400" />

        <span className="flex-1 truncate text-sm font-medium" title={workspace.path}>
          {workspace.name}
        </span>

        {pastSessions.length > 0 && (
          <span className="shrink-0 rounded-full bg-gray-700 px-1.5 py-0.5 text-[10px] text-gray-400">
            {pastSessions.length}
          </span>
        )}
      </div>

      {/* Past sessions (expanded) */}
      {expanded && (
        <div className="ml-4 flex flex-col gap-0.5 pb-1">
          {pastSessions.length === 0 ? (
            <span className="px-3 py-1 text-xs text-gray-600">세션 없음</span>
          ) : (
            pastSessions.map((session) => (
              <button
                key={session.id}
                onClick={() => handleSessionClick(session.id)}
                className={[
                  'flex w-full flex-col gap-0.5 rounded-md px-3 py-1.5 text-left transition-colors',
                  activeSessionId === session.id
                    ? 'bg-blue-900/30 text-gray-200'
                    : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200',
                ].join(' ')}
              >
                <span className="line-clamp-1 text-xs leading-relaxed">
                  {session.preview ?? '(내용 없음)'}
                </span>
                <span className="text-[10px] text-gray-600">
                  {formatRelativeTime(session.createdAt)}
                </span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}
