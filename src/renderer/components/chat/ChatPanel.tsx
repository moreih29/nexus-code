import log from 'electron-log/renderer'
import { useEffect, useRef } from 'react'
import { IpcChannel } from '../../../shared/ipc'
import type { StartResponse, PromptResponse, CancelResponse } from '../../../shared/types'
import { useSessionStore } from '../../stores/session-store'
import { useWorkspaceStore } from '../../stores/workspace-store'
import { ChatInput } from './ChatInput'
import { MessageBubble } from './MessageBubble'

export function ChatPanel() {
  const {
    sessionId,
    status,
    messages,
    startSession,
    setStatus,
    addUserMessage,
    dismissTimeout,
  } = useSessionStore()

  const activeWorkspace = useWorkspaceStore((s) => s.activeWorkspace)
  const saveSessionId = useWorkspaceStore((s) => s.saveSessionId)
  const bottomRef = useRef<HTMLDivElement>(null)

  // Auto-scroll on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // timeout IPC 이벤트 수신
  useEffect(() => {
    const onTimeout = (): void => {
      setStatus('timeout')
    }
    window.electronAPI.on(IpcChannel.TIMEOUT, onTimeout)
    return () => {
      window.electronAPI.off(IpcChannel.TIMEOUT, onTimeout)
    }
  }, [setStatus])

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

  const handleTimeoutCancel = async (): Promise<void> => {
    if (!sessionId) return
    try {
      await window.electronAPI.invoke<CancelResponse>(IpcChannel.CANCEL, { sessionId })
    } catch (err) {
      log.error('[ChatPanel] timeout cancel error:', err)
    }
    setStatus('idle')
  }

  const isInputDisabled = !activeWorkspace || status === 'running' || status === 'waiting_permission' || status === 'timeout'

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

      {/* 타임아웃 알림 */}
      {status === 'timeout' && (
        <div className="mx-4 mb-2 flex items-center justify-between rounded-lg border border-yellow-600/40 bg-yellow-900/20 px-4 py-3">
          <p className="text-sm text-yellow-300">
            응답 없음 — CLI가 2분 이상 반응하지 않습니다.
          </p>
          <div className="flex gap-2">
            <button
              onClick={dismissTimeout}
              className="rounded px-3 py-1 text-xs text-yellow-300 hover:bg-yellow-800/40"
            >
              계속 대기
            </button>
            <button
              onClick={handleTimeoutCancel}
              className="rounded bg-yellow-700/60 px-3 py-1 text-xs text-yellow-100 hover:bg-yellow-700"
            >
              취소
            </button>
          </div>
        </div>
      )}

      {/* Input */}
      <ChatInput onSend={handleSend} disabled={isInputDisabled} />
    </div>
  )
}
