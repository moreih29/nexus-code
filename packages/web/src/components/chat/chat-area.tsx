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
    enabled: !!workspacePath && !!sessionId,
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

        // 가장 최근 세션 (created_at DESC 정렬 가정, 아니면 수동 정렬)
        const latest = sessions.sort(
          (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
        )[0]

        const { messages } = await fetchHistory(latest.id, { limit: 100 })

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
      } catch {
        // 서버 미연결 — 무시
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
