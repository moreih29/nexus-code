import type { ToolCallState, PermissionRequestState } from '../../adapters/session-adapter.js'
import { ToolGroup } from './tool-group.js'
import { SubagentResultBlock } from './subagent-result-block.js'
import { PermissionBlock } from './permission-block.js'

// DisplayMessage covers both MockMessage and ChatMessage shapes
interface DisplayMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  label?: string
  toolCalls?: ToolCallState[]
  permissionRequest?: PermissionRequestState
  subagentSpawn?: { count: number }
  subagentResult?: { name: string; type: string; summary: string }
  isStreaming?: boolean
}

interface MessageBubbleProps {
  message: DisplayMessage
}

export function MessageBubble({ message }: MessageBubbleProps) {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div
          className="max-w-[75%] rounded-[12px_12px_4px_12px] px-[14px] py-[10px] text-[13px] leading-relaxed text-text-primary"
          style={{
            background: 'var(--accent-dim)',
            border: '1px solid rgba(88,166,255,.2)',
          }}
        >
          {message.text}
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      {message.label && (
        <span className="text-[11px] text-text-secondary font-medium">{message.label}</span>
      )}

      {message.text && (
        <div className="text-[13px] leading-[1.6] text-text-primary">
          {message.text}
          {message.isStreaming && <span className="streaming-cursor" />}
        </div>
      )}

      {message.toolCalls && message.toolCalls.length > 0 && (
        <ToolGroup toolCalls={message.toolCalls} />
      )}

      {message.subagentResult && (
        <SubagentResultBlock
          name={message.subagentResult.name}
          type={message.subagentResult.type}
          summary={message.subagentResult.summary}
        />
      )}

      {message.permissionRequest && (
        <PermissionBlock permission={message.permissionRequest} />
      )}
    </div>
  )
}
