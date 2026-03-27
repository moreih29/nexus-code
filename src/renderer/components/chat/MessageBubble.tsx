import { MarkdownRenderer } from './MarkdownRenderer'
import { ToolRenderer } from './ToolRenderer'
import type { Message } from '../../stores/session-store'

interface MessageBubbleProps {
  message: Message
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
              <ToolRenderer key={tc.toolUseId} tc={tc} />
            ))}
          </>
        )}
      </div>
    </div>
  )
}
