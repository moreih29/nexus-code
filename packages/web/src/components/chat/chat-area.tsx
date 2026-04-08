import { useCallback, useEffect, useRef } from 'react'
import { useChatStore } from '../../stores/chat-store.js'
import { useWorkspaceStore } from '../../stores/workspace-store.js'
import { useWorkspaces } from '../../hooks/use-workspaces.js'
import { useSse } from '../../api/use-sse.js'
import { fetchSessions, fetchHistory } from '../../api/session.js'
import type { SessionEvent } from '@nexus/shared'
import type { ChatMessage } from '../../adapters/session-adapter.js'
import { AgentTabs } from './agent-tabs.js'
import { ChatMessages } from './chat-messages.js'
import { SubagentPanel } from './subagent-panel.js'
import { ChatInput } from './chat-input.js'

let _idCounter = 1000

function useChatSession() {
  const { data: workspaces } = useWorkspaces()
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)
  const { sessionId, applyServerEvent, setConnected, setSessionId, restoreFromHistory, resetSession } =
    useChatStore()
  const connectedRef = useRef(false)
  const restoredForRef = useRef<string | null>(null)

  const activeWorkspace = workspaces?.find((ws) => ws.id === activeWorkspaceId)
  const workspacePath = activeWorkspace?.path ?? ''

  const handleEvent = useCallback(
    (event: SessionEvent) => {
      applyServerEvent(event)
    },
    [applyServerEvent],
  )

  useSse({
    workspacePath,
    onEvent: handleEvent,
    enabled: !!workspacePath,
  })

  // 워크스페이스 변경 시 최근 세션의 히스토리 복원
  useEffect(() => {
    if (!workspacePath) {
      setConnected(false)
      return
    }

    connectedRef.current = true
    setConnected(true)

    // 이미 이 워크스페이스에 대해 복원했으면 스킵
    if (restoredForRef.current === workspacePath) return
    restoredForRef.current = workspacePath

    void (async () => {
      try {
        const sessions = await fetchSessions(workspacePath)
        if (sessions.length === 0) return

        // 가장 최근 세션부터 시도, 히스토리 없으면 다음 세션으로 폴백
        const sorted = sessions.sort(
          (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
        )

        let latest: (typeof sorted)[number] | undefined
        let messages: Awaited<ReturnType<typeof fetchHistory>>['messages'] = []

        for (const session of sorted.slice(0, 5)) {
          try {
            const result = await fetchHistory(session.id, { limit: 100 })
            latest = session
            messages = result.messages
            break
          } catch {
            // 이 세션은 히스토리 불가 — 다음 세션 시도
            continue
          }
        }

        if (!latest) return

        // 히스토리 메시지를 ChatMessage 형식으로 변환
        const chatMessages: ChatMessage[] = messages
          .filter((m) => !m.isSidechain)
          .map((m) => {
            if (m.type === 'user') {
              const content = m.content as { text?: string; kind?: string }
              return {
                id: m.uuid ?? `h-${_idCounter++}`,
                role: 'user' as const,
                text: content?.text ?? '',
              }
            }
            // assistant
            const content = m.content as { blocks?: Array<{ type: string; text?: string }> }
            const textBlocks = content?.blocks?.filter((b) => b.type === 'text') ?? []
            const text = textBlocks.map((b) => b.text ?? '').join('\n')
            return {
              id: m.uuid ?? `h-${_idCounter++}`,
              role: 'assistant' as const,
              text,
            }
          })
          .filter((m) => m.text)

        if (chatMessages.length > 0) {
          // 히스토리 표시 + resume용 세션 ID 저장 (메시지 전송 시 resume 호출됨)
          restoreFromHistory(latest.id, chatMessages)
        }
      } catch (err) {
        console.warn('[chat] 히스토리 복원 실패:', err)
        // 에러 시 시스템 메시지로 표시
        restoreFromHistory('', [{
          id: `err-${Date.now()}`,
          role: 'assistant',
          text: '⚠️ 이전 대화를 불러올 수 없습니다. 새 대화를 시작해주세요.',
        }])
      }
    })()
  }, [workspacePath, setConnected, setSessionId, restoreFromHistory, resetSession])

  return { workspacePath }
}

export function ChatArea() {
  useChatSession()

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <AgentTabs />
      <ChatMessages />
      <SubagentPanel />
      <ChatInput />
    </div>
  )
}
