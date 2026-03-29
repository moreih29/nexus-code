import { memo } from 'react'
import { MarkdownRenderer } from './MarkdownRenderer'
import { ToolRenderer } from './ToolRenderer'
import type { Message } from '../../stores/session-store'
import { useCheckpointStore } from '../../stores/checkpoint-store'
import { useWorkspaceStore } from '../../stores/workspace-store'
import type { Checkpoint } from '../../../shared/types'

interface MessageBubbleProps {
  message: Message
  /** assistant 버블에만 전달 — 직전 user 메시지의 checkpointRef */
  checkpointRef?: string
}

const HIDDEN_TOOLS = new Set(['TodoWrite', 'AskUserQuestion'])
const CODE_CHANGE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit'])

function MessageBubbleInner({ message, checkpointRef }: MessageBubbleProps) {
  const isUser = message.role === 'user'

  // assistant 메시지에서 표시할 toolCalls 필터링
  const visibleToolCalls = message.toolCalls?.filter((tc) => !HIDDEN_TOOLS.has(tc.name))

  // content 없고 표시할 toolCalls도 없으면 빈 버블 → 렌더링하지 않음
  if (!isUser && !message.content && (!visibleToolCalls || visibleToolCalls.length === 0)) {
    return null
  }

  // 코드 변경 도구(Edit/Write/MultiEdit)가 포함된 턴인지 확인
  const hasCodeChanges = message.toolCalls?.some((tc) => CODE_CHANGE_TOOLS.has(tc.name)) ?? false

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={[
          'max-w-[80%] rounded-2xl px-4 py-3 text-sm',
          isUser
            ? 'bg-primary text-primary-foreground'
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
            {hasCodeChanges && checkpointRef && (
              <RestoreButton checkpointRef={checkpointRef} timestamp={message.timestamp} />
            )}
          </>
        )}
      </div>
    </div>
  )
}

export const MessageBubble = memo(MessageBubbleInner, (prev, next) =>
  prev.message.id === next.message.id &&
  prev.message.content === next.message.content &&
  prev.message.toolCalls?.length === next.message.toolCalls?.length &&
  prev.checkpointRef === next.checkpointRef
)

function RestoreButton({ checkpointRef, timestamp }: { checkpointRef: string; timestamp: number }) {
  const { restoreCheckpoint, isRestoring } = useCheckpointStore()
  const activeWorkspace = useWorkspaceStore((s) => s.activeWorkspace)

  if (!activeWorkspace) return null

  const timeLabel = new Date(timestamp).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })

  const handleRestore = async (): Promise<void> => {
    const confirmed = window.confirm(
      `현재 변경사항을 버리고 ${timeLabel} 시점으로 코드를 되돌리시겠습니까?\n(대화 메시지는 유지됩니다)`
    )
    if (!confirmed) return

    // checkpointRef(hash)로 Checkpoint 객체 구성
    const checkpoint: Checkpoint = {
      hash: checkpointRef,
      headHash: '',
      sessionId: '',
      timestamp,
    }
    await restoreCheckpoint(activeWorkspace, checkpoint)
  }

  return (
    <div className="mt-2 flex justify-end">
      <button
        onClick={() => void handleRestore()}
        disabled={isRestoring}
        className="rounded px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
      >
        {isRestoring ? '복원 중...' : '되돌리기'}
      </button>
    </div>
  )
}
