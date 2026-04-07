import { useRef, useState } from 'react'
import { useChatStore } from '../../stores/chat-store.js'
import { useWorkspaceStore } from '../../stores/workspace-store.js'
import { useWorkspaces } from '../../hooks/use-workspaces.js'
import { useStartSession, useSendPrompt } from '../../hooks/use-session.js'
import { useSettingsStore } from '../../stores/settings-store.js'

export function ChatInput() {
  const [value, setValue] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const { data: workspaces } = useWorkspaces()
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)
  const { sessionId, sendMessage, setSessionId, setUseMock } = useChatStore()

  const activeWorkspace = workspaces?.find((ws) => ws.id === activeWorkspaceId)
  const workspacePath = activeWorkspace?.path ?? ''

  const startSession = useStartSession()
  const sendPrompt = useSendPrompt(sessionId ?? '')

  async function handleSend() {
    const trimmed = value.trim()
    if (!trimmed) return

    setValue('')
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }

    // Optimistically add user message to store
    sendMessage(trimmed)

    if (!workspacePath) {
      // No server connection — stay in mock mode
      return
    }

    try {
      if (!sessionId) {
        // First message — start a new session
        setUseMock(false)
        console.log('[chat-input] starting session', { workspacePath, prompt: trimmed })
        const { defaultModel, defaultPermissionMode } = useSettingsStore.getState()
        const response = await startSession.mutateAsync({
          workspacePath,
          prompt: trimmed,
          model: defaultModel,
          permissionMode: defaultPermissionMode === 'default' ? undefined : defaultPermissionMode,
        })
        console.log('[chat-input] session started', response)
        setSessionId(response.id)
      } else {
        // Subsequent messages — send prompt to existing session
        await sendPrompt.mutateAsync(trimmed)
      }
    } catch {
      // Server unreachable — fall back to mock mode silently
      setUseMock(true)
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void handleSend()
    }
  }

  function handleInput(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setValue(e.target.value)
    // Auto-resize
    const el = e.target
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }

  const isSending = startSession.isPending || sendPrompt.isPending

  return (
    <div className="px-5 py-3 pb-4 border-t border-border flex-shrink-0">
      <div
        className="flex items-end gap-2 rounded-[10px] px-3 py-2 border border-border transition-colors duration-200 focus-within:border-accent"
        style={{ background: 'var(--bg-surface)' }}
      >
        <textarea
          ref={textareaRef}
          className="flex-1 bg-transparent border-none text-[13px] text-text-primary placeholder:text-text-muted outline-none resize-none min-h-5 leading-5 font-[inherit]"
          placeholder="메시지 입력..."
          rows={1}
          value={value}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          disabled={isSending}
        />
        <button
          className="flex-shrink-0 w-7 h-7 rounded-md flex items-center justify-center transition-opacity duration-150 hover:opacity-85 disabled:opacity-40 disabled:cursor-not-allowed"
          style={{ background: 'var(--accent)' }}
          disabled={!value.trim() || isSending}
          onClick={() => void handleSend()}
          aria-label="전송"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M7 1L7 13M7 1L2 6M7 1L12 6" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>
    </div>
  )
}
