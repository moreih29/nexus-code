import { useEffect } from 'react'
import { useHistoryStore } from '../../stores/history-store'
import { SessionItem } from './SessionItem'
import { NewSessionButton } from './NewSessionButton'

export function SessionList() {
  const { sessions, loading, loadSessions } = useHistoryStore()

  useEffect(() => {
    loadSessions()
  }, [loadSessions])

  return (
    <div className="flex h-full flex-col">
      {/* New session button */}
      <div className="border-b border-border px-2 py-2">
        <NewSessionButton />
      </div>

      {/* Session list */}
      <div className="flex-1 overflow-y-auto px-2 py-2">
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <span className="text-xs text-dim-foreground">불러오는 중...</span>
          </div>
        ) : sessions.length === 0 ? (
          <div className="flex items-center justify-center py-8">
            <span className="text-xs text-dim-foreground">세션 없음</span>
          </div>
        ) : (
          <div className="flex flex-col gap-0.5">
            {sessions.map((session) => (
              <SessionItem key={session.id} session={session} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
