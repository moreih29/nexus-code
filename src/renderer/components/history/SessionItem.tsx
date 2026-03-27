import type { SessionInfo } from '../../../shared/types'
import { useHistoryStore } from '../../stores/history-store'
import { useSessionStore } from '../../stores/session-store'

interface SessionItemProps {
  session: SessionInfo
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

function cwdLabel(cwd: string): string {
  const parts = cwd.split('/')
  return parts[parts.length - 1] || cwd
}

export function SessionItem({ session }: SessionItemProps) {
  const { activeSessionId, resumeSession } = useHistoryStore()
  const startSession = useSessionStore((s) => s.startSession)
  const isActive = activeSessionId === session.id

  const handleClick = async (): Promise<void> => {
    const ok = await resumeSession(session.id)
    if (ok) {
      startSession(session.id)
    }
  }

  return (
    <button
      onClick={handleClick}
      className={[
        'flex w-full flex-col gap-0.5 rounded-md px-3 py-2 text-left transition-colors',
        isActive
          ? 'bg-blue-900/40 text-gray-100'
          : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200',
      ].join(' ')}
    >
      {/* Preview text */}
      <span className="line-clamp-2 text-xs leading-relaxed">
        {session.preview ?? '(내용 없음)'}
      </span>

      {/* Meta row */}
      <div className="flex items-center gap-2 text-[10px] text-gray-600">
        <span className="truncate max-w-[100px]" title={session.cwd}>
          {cwdLabel(session.cwd)}
        </span>
        <span>·</span>
        <span className="shrink-0">{formatRelativeTime(session.createdAt)}</span>
      </div>
    </button>
  )
}
