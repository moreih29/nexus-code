import { useEffect, useRef } from 'react'
import { IpcChannel } from '../../../shared/ipc'
import type {
  StartResponse,
  PromptResponse,
  TextChunkEvent,
  ToolCallEvent,
  ToolResultEvent,
  SessionEndEvent,
} from '../../../shared/types'
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
    addUserMessage,
    appendTextChunk,
    flushStreamBuffer,
    addToolCall,
    resolveToolCall,
    endSession,
  } = useSessionStore()

  const activeWorkspace = useWorkspaceStore((s) => s.activeWorkspace)
  const bottomRef = useRef<HTMLDivElement>(null)

  // Auto-scroll on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Subscribe to stream events
  useEffect(() => {
    const onTextChunk = (event: TextChunkEvent): void => {
      appendTextChunk(event.text)
    }

    const onToolCall = (event: ToolCallEvent): void => {
      addToolCall(event)
    }

    const onToolResult = (event: ToolResultEvent): void => {
      resolveToolCall(event.toolUseId, event.content, event.isError)
    }

    const onSessionEnd = (_event: SessionEndEvent): void => {
      flushStreamBuffer()
      endSession()
    }

    window.electronAPI.on(IpcChannel.TEXT_CHUNK, onTextChunk as (...args: unknown[]) => void)
    window.electronAPI.on(IpcChannel.TOOL_CALL, onToolCall as (...args: unknown[]) => void)
    window.electronAPI.on(IpcChannel.TOOL_RESULT, onToolResult as (...args: unknown[]) => void)
    window.electronAPI.on(IpcChannel.SESSION_END, onSessionEnd as (...args: unknown[]) => void)

    return () => {
      window.electronAPI.off(IpcChannel.TEXT_CHUNK, onTextChunk as (...args: unknown[]) => void)
      window.electronAPI.off(IpcChannel.TOOL_CALL, onToolCall as (...args: unknown[]) => void)
      window.electronAPI.off(IpcChannel.TOOL_RESULT, onToolResult as (...args: unknown[]) => void)
      window.electronAPI.off(IpcChannel.SESSION_END, onSessionEnd as (...args: unknown[]) => void)
    }
  }, [appendTextChunk, addToolCall, resolveToolCall, flushStreamBuffer, endSession])

  const handleSend = async (text: string): Promise<void> => {
    if (!activeWorkspace) {
      console.warn('[ChatPanel] 워크스페이스가 선택되지 않음')
      return
    }

    addUserMessage(text)
    console.log('[ChatPanel] 전송:', { text: text.slice(0, 50), cwd: activeWorkspace, sessionId })

    try {
      if (!sessionId) {
        const res = await window.electronAPI.invoke<StartResponse>(IpcChannel.START, {
          prompt: text,
          cwd: activeWorkspace,
          permissionMode: 'auto',
        })
        console.log('[ChatPanel] 세션 시작:', res.sessionId)
        startSession(res.sessionId)
      } else {
        await window.electronAPI.invoke<PromptResponse>(IpcChannel.PROMPT, {
          sessionId,
          message: text,
        })
      }
    } catch (err) {
      console.error('[ChatPanel] IPC error:', err)
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
