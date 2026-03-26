import { MarkdownRenderer } from './MarkdownRenderer'
import type { Message, ToolCallRecord } from '../../stores/session-store'

interface MessageBubbleProps {
  message: Message
}

function ToolCallBadge({ tc }: { tc: ToolCallRecord }): JSX.Element {
  return (
    <div className="mt-2 rounded border border-gray-700 bg-gray-800/60 px-3 py-2 text-xs">
      <div className="flex items-center gap-2">
        <span className="font-mono text-blue-400">{tc.name}</span>
        {tc.result !== undefined && (
          <span
            className={
              tc.isError ? 'text-red-400' : 'text-green-400'
            }
          >
            {tc.isError ? 'error' : 'done'}
          </span>
        )}
        {tc.result === undefined && (
          <span className="animate-pulse text-gray-500">running…</span>
        )}
      </div>
    </div>
  )
}

export function MessageBubble({ message }: MessageBubbleProps): JSX.Element {
  const isUser = message.role === 'user'

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={[
          'max-w-[80%] rounded-2xl px-4 py-3 text-sm',
          isUser
            ? 'bg-blue-600 text-white'
            : 'bg-gray-800 text-gray-200',
        ].join(' ')}
      >
        {isUser ? (
          <p className="whitespace-pre-wrap">{message.content}</p>
        ) : (
          <>
            {message.content && <MarkdownRenderer content={message.content} />}
            {message.toolCalls?.map((tc) => (
              <ToolCallBadge key={tc.toolUseId} tc={tc} />
            ))}
          </>
        )}
      </div>
    </div>
  )
}
