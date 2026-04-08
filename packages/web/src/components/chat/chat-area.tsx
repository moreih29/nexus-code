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

  // Only connect SSE when there's an active or restorable session — prevents 404 spam
  // before a session is started (server creates WorkspaceGroup on first session)
  const hasSession = useChatStore((s) => !!(s.sessionId || s.restorableSessionId))
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
