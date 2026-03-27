import { MarkdownRenderer } from './MarkdownRenderer'
import { ToolRenderer } from './ToolRenderer'
import type { Message } from '../../stores/session-store'

interface MessageBubbleProps {
  message: Message
}

const HIDDEN_TOOLS = new Set(['TodoWrite', 'AskUserQuestion'])

export function MessageBubble({ message }: MessageBubbleProps) {
  const isUser = message.role === 'user'

  // assistant 메시지에서 표시할 toolCalls 필터링
  const visibleToolCalls = message.toolCalls?.filter((tc) => !HIDDEN_TOOLS.has(tc.name))

  // content 없고 표시할 toolCalls도 없으면 빈 버블 → 렌더링하지 않음
  if (!isUser && !message.content && (!visibleToolCalls || visibleToolCalls.length === 0)) {
    return null
  }

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={[
          'max-w-[80%] rounded-2xl px-4 py-3 text-sm',
          isUser
            ? 'bg-blue-600 text-white'
            : 'bg-muted text-foreground',
        ].join(' ')}
      >
        {isUser ? (
          <p className="whitespace-pre-wrap">{message.content}</p>
        ) : (
          <>
            {message.content && <MarkdownRenderer content={message.content} />}
            {visibleToolCalls?.map((tc) => (
              <ToolRenderer key={tc.toolUseId} tc={tc} />
            ))}
          </>
        )}
      </div>
    </div>
  )
}
