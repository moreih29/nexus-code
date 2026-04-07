import { useEffect, useRef } from 'react'
import { useChatStore } from '../../stores/chat-store.js'
import { MessageBubble } from './message-bubble.js'
import type { ToolCallState } from '../../adapters/session-adapter.js'

// DisplayMessage covers both MockMessage and ChatMessage shapes
interface DisplayMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  label?: string
  toolCalls?: ToolCallState[]
  permissionRequest?: { id: string; toolName: string; toolInput: Record<string, unknown> }
  subagentSpawn?: { count: number }
  subagentResult?: { name: string; type: string; summary: string }
  isStreaming?: boolean
}

function ToolCallRow({ tc }: { tc: ToolCallState }) {
  const inputStr = JSON.stringify(tc.input)
  const statusColor =
    tc.status === 'success'
      ? 'text-green'
      : tc.status === 'error'
        ? 'text-red'
        : 'text-yellow'

  return (
    <div className="flex flex-col gap-0.5 py-1.5 border-b border-border last:border-b-0">
      <div className="flex items-center gap-2 text-[11.5px]">
        <span className="font-semibold text-text-primary">{tc.name}</span>
        <span className="text-text-muted font-mono truncate max-w-[300px]">{inputStr}</span>
        <span className={`ml-auto text-[11px] flex items-center gap-1 ${statusColor}`}>
          {tc.status === 'running' && (
            <span
              className="inline-block w-3 h-3 rounded-full border-2 border-border flex-shrink-0"
              style={{ borderTopColor: 'var(--green)', animation: 'spin .8s linear infinite' }}
            />
          )}
          {tc.status}
        </span>
      </div>
      {tc.result && (
        <div className="text-[11px] text-text-secondary font-mono whitespace-pre-wrap pl-2 border-l-2 border-border">
          {tc.result}
        </div>
      )}
    </div>
  )
}

export function ChatMessages() {
  const { activeTab, getActiveMessages, getActiveSubagent } = useChatStore()
  const rawMessages = getActiveMessages()
  const messages = rawMessages as DisplayMessage[]
  const activeSubagent = getActiveSubagent()
  const bottomRef = useRef<HTMLDivElement>(null)

  // TODO: preserve scroll position per tab on tab switch
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const isSubagentTab = activeTab !== 'main'

  return (
    <div className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-4">
      {isSubagentTab && activeSubagent && (
        <div className="text-[11px] text-text-muted border-b border-border pb-3 mb-1">
          <span className="font-semibold text-text-secondary">{activeSubagent.name}</span>
          <span className="mx-1.5 text-border">·</span>
          <span>{activeSubagent.type}</span>
          {activeSubagent.durationSec !== undefined && (
            <span className="ml-2">{activeSubagent.durationSec}초</span>
          )}
          <span className="ml-2 text-text-secondary">{activeSubagent.summary}</span>
        </div>
      )}

      {messages.map((msg) => {
        if (isSubagentTab && msg.toolCalls && msg.toolCalls.length > 0) {
          return (
            <div
              key={msg.id}
              className="rounded-md border border-border overflow-hidden"
              style={{ background: 'var(--bg-surface)' }}
            >
              <div
                className="px-3 py-2 text-[11px] text-text-secondary"
                style={{ background: 'var(--bg-elevated)' }}
              >
                {msg.label && (
                  <span className="font-semibold text-text-primary mr-2">{msg.label}</span>
                )}
                도구 호출 목록
              </div>
              <div className="px-3 py-1 divide-y divide-border">
                {msg.toolCalls.map((tc) => (
                  <ToolCallRow key={tc.id} tc={tc} />
                ))}
              </div>
            </div>
          )
        }

        return <MessageBubble key={msg.id} message={msg} />
      })}

      <div ref={bottomRef} />
    </div>
  )
}
