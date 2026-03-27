import log from 'electron-log/renderer'
import { useEffect, useRef } from 'react'
import { IpcChannel } from '../../../shared/ipc'
import type { StartResponse, PromptResponse } from '../../../shared/types'
import { useSessionStore } from '../../stores/session-store'
import { useWorkspaceStore } from '../../stores/workspace-store'
import { ChatInput } from './ChatInput'
import { MessageBubble } from './MessageBubble'

export function ChatPanel(): JSX.Element {
  const {
    sessionId,
    status,
    messages,
    startSession,
    setStatus,
    addUserMessage,
  } = useSessionStore()

  const activeWorkspace = useWorkspaceStore((s) => s.activeWorkspace)
  const saveSessionId = useWorkspaceStore((s) => s.saveSessionId)
  const bottomRef = useRef<HTMLDivElement>(null)

  // Auto-scroll on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const handleSend = async (text: string): Promise<void> => {
    if (!activeWorkspace) {
      log.warn('[ChatPanel] 워크스페이스가 선택되지 않음')
      return
    }

    addUserMessage(text)
    setStatus('running')
    log.info('[ChatPanel] 전송:', { text: text.slice(0, 50), cwd: activeWorkspace, sessionId })

    try {
      if (!sessionId) {
        const res = await window.electronAPI.invoke<StartResponse>(IpcChannel.START, {
          prompt: text,
          cwd: activeWorkspace,
          permissionMode: 'auto',
        })
        log.info('[ChatPanel] 세션 시작:', res.sessionId)
        startSession(res.sessionId)
        await saveSessionId(activeWorkspace, res.sessionId)
      } else {
        const res = await window.electronAPI.invoke<PromptResponse>(IpcChannel.PROMPT, {
          sessionId,
          message: text,
        })
        if (!res.ok) {
          // 프로세스가 죽었음 → START + --resume로 자동 복구
          log.warn('[ChatPanel] PROMPT failed — resuming session:', sessionId)
          const resumed = await window.electronAPI.invoke<StartResponse>(IpcChannel.START, {
            prompt: text,
            cwd: activeWorkspace,
            permissionMode: 'auto',
            sessionId,
          })
          log.info('[ChatPanel] 세션 복구:', resumed.sessionId)
          startSession(resumed.sessionId)
        }
      }
    } catch (err) {
      log.error('[ChatPanel] IPC error:', err)
      setStatus('idle')
    }
  }

  const isInputDisabled = !activeWorkspace || status === 'running' || status === 'waiting_permission'

  return (
    <div className="flex h-full flex-col">
      {/* Message list */}
      <div className="flex-1 overflow-y-auto px-4 py-4">
        {messages.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <p className="text-sm text-gray-600">
              {activeWorkspace
                ? '메시지를 입력하여 세션을 시작하세요.'
                : '좌측에서 워크스페이스를 선택하세요.'}
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {messages.map((msg) => (
              <MessageBubble key={msg.id} message={msg} />
            ))}
            <div ref={bottomRef} />
          </div>
        )}
      </div>

      {/* Input */}
      <ChatInput onSend={handleSend} disabled={isInputDisabled} />
    </div>
  )
}
