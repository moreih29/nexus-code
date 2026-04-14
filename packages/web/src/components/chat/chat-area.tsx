import { useCallback, useEffect } from 'react'
import { useChatStore } from '../../stores/chat-store.js'
import { useActiveWorkspace } from '../../hooks/use-active-workspace.js'
import { useSse } from '../../api/use-sse.js'
import { useSessionRestore } from '../../hooks/use-session-restore.js'
import type { SessionEvent } from '@nexus/shared'
import { AgentTabs } from './agent-tabs.js'
import { ChatMessages } from './chat-messages.js'
import { SubagentPanel } from './subagent-panel.js'
import { ChatInput } from './chat-input.js'

function useChatSession() {
  const { workspacePath: rawWorkspacePath } = useActiveWorkspace()
  const workspacePath = rawWorkspacePath ?? ''
  const { applyServerEvent, setConnected } = useChatStore()

  // workspacePath 변경(전환 또는 전체 삭제로 null) 시 이전 세션 상태 클린업.
  // useSessionRestore가 이후 새 path의 히스토리를 시도한다.
  useEffect(() => {
    useChatStore.getState().resetSession()
  }, [workspacePath])

  useEffect(() => {
    setConnected(!!workspacePath)
    return () => setConnected(false)
  }, [workspacePath, setConnected])

  const handleEvent = useCallback(
    (event: SessionEvent) => {
      applyServerEvent(event)
    },
    [applyServerEvent],
  )

  // Only connect SSE when there's an active session (not just restorable) —
  // server creates WorkspaceGroup only when a session is actually started/resumed,
  // so restorableSessionId alone doesn't mean the server has a group ready.
  const hasSession = useChatStore((s) => !!s.sessionId)
  useSse({ workspacePath, onEvent: handleEvent, enabled: !!workspacePath && hasSession })
  useSessionRestore(workspacePath)

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
