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

  // SSE를 workspace 선택 즉시 연결한다. 서버 events 라우트가 group 없어도 연결을 유지하고
  // polling으로 group 생성을 감지해 subscribe하므로, resume/start 전에도 이벤트 수신이 가능하다.
  // 이 설계는 resume API 응답과 SSE 연결 사이의 race로 첫 이벤트를 놓치던 문제를 제거한다.
  useSse({ workspacePath, onEvent: handleEvent, enabled: !!workspacePath })
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
