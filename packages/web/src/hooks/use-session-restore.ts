import { useEffect, useRef } from 'react'
import { fetchSessions, fetchHistory } from '../api/session.js'
import { historyMessagesToChatMessages } from '../adapters/session-adapter.js'
import { useChatStore } from '../stores/chat-store.js'

export function useSessionRestore(workspacePath: string) {
  const { restoreFromHistory } = useChatStore()
  const restoredForRef = useRef<string | null>(null)

  useEffect(() => {
    if (!workspacePath) return
    if (restoredForRef.current === workspacePath) return
    restoredForRef.current = workspacePath

    void (async () => {
      try {
        const sessions = await fetchSessions(workspacePath)
        if (sessions.length === 0) return

        const sorted = sessions.sort(
          (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
        )

        let latest: (typeof sorted)[number] | undefined
        let historyMessages: Awaited<ReturnType<typeof fetchHistory>>['messages'] = []

        for (const session of sorted.slice(0, 5)) {
          try {
            const result = await fetchHistory(session.id, { limit: 100 })
            latest = session
            historyMessages = result.messages
            break
          } catch {
            continue
          }
        }

        if (!latest) return

        const chatMessages = historyMessagesToChatMessages(historyMessages)
        if (chatMessages.length > 0) {
          restoreFromHistory(latest.id, chatMessages)
        }
      } catch (err) {
        console.warn('[chat] 히스토리 복원 실패:', err)
        restoreFromHistory('', [
          {
            id: `err-${Date.now()}`,
            role: 'assistant',
            text: '⚠️ 이전 대화를 불러올 수 없습니다. 새 대화를 시작해주세요.',
          },
        ])
      }
    })()
  }, [workspacePath, restoreFromHistory])
}
