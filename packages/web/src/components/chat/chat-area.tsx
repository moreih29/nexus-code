import { useCallback, useEffect, useRef } from 'react'
import { useChatStore } from '../../stores/chat-store.js'
import { useWorkspaceStore } from '../../stores/workspace-store.js'
import { useWorkspaces } from '../../hooks/use-workspaces.js'
import { useSse } from '../../api/use-sse.js'
import type { SessionEvent } from '@nexus/shared'
import { AgentTabs } from './agent-tabs.js'
import { ChatMessages } from './chat-messages.js'
import { SubagentPanel } from './subagent-panel.js'
import { ChatInput } from './chat-input.js'

function useChatSession() {
  const { data: workspaces } = useWorkspaces()
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)
  const { sessionId, applyServerEvent, setConnected, setUseMock } = useChatStore()
  const connectedRef = useRef(false)

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

  // When workspace is available, disable mock mode
  useEffect(() => {
    if (workspacePath) {
      // Will switch to live mode once a session starts
      connectedRef.current = true
      setConnected(true)
    }
  }, [workspacePath, setConnected])

  // Track connection health via SSE onerror — useSse closes on error
  // We reset to mock mode if we never had a session and server is unreachable
  useEffect(() => {
    if (!workspacePath) {
      setUseMock(true)
      setConnected(false)
    }
  }, [workspacePath, setUseMock, setConnected])

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
