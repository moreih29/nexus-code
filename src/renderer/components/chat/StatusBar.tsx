import { Check, Circle, Loader2, Minus } from 'lucide-react'
import { useActiveSession } from '../../stores/session-store'
import { useStatusBarStore } from '../../stores/status-bar-store'
import type { TodoItem } from '../../stores/status-bar-store'
import { useRightPanelUIStore } from '../../stores/plugin-store'

const TODO_PREVIEW_LIMIT = 3

function TodoChecklist({ todos }: { todos: TodoItem[] }) {
  const setActiveTab = useRightPanelUIStore((s) => s.setActiveTab)
  const preview = todos.slice(0, TODO_PREVIEW_LIMIT)
  const remaining = todos.length - TODO_PREVIEW_LIMIT

  return (
    <div className="flex flex-col gap-1">
      {preview.map((todo, idx) => (
        <div key={idx} className="flex items-center gap-2 text-sm">
          {todo.status === 'completed' ? (
            <Check className="h-3.5 w-3.5 shrink-0 text-success" />
          ) : todo.status === 'in_progress' ? (
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
          ) : (
            <Minus className="h-3.5 w-3.5 shrink-0 text-dim-foreground" />
          )}
          <span
            className={
              todo.status === 'completed'
                ? 'text-dim-foreground line-through'
                : todo.status === 'in_progress'
                  ? 'text-foreground'
                  : 'text-muted-foreground'
            }
          >
            {todo.content}
          </span>
        </div>
      ))}
      {remaining > 0 && (
        <button
          onClick={() => setActiveTab('nexus')}
          className="self-start pl-5 text-xs text-primary hover:text-primary/80 hover:underline cursor-pointer transition-colors"
        >
          {remaining}개 더 보기 →
        </button>
      )}
    </div>
  )
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

export function StatusBar() {
  const status = useActiveSession((s) => s.status)
  const sendResponse = useActiveSession((s) => s.sendResponse)
  const lastTurnStats = useActiveSession((s) => s.lastTurnStats)
  const turnHistory = useActiveSession((s) => s.turnHistory)
  const todos = useStatusBarStore((s) => s.todos)
  const askQuestion = useStatusBarStore((s) => s.askQuestion)
  const setAskQuestion = useStatusBarStore((s) => s.setAskQuestion)

  const isRunning = status === 'running'
  const hasTodos = todos.length > 0
  const hasAskQuestion = askQuestion !== null
  const hasStats = !isRunning && lastTurnStats !== null && (
    lastTurnStats.inputTokens !== undefined ||
    lastTurnStats.outputTokens !== undefined ||
    lastTurnStats.costUsd !== undefined
  )

  // running 상태이거나 표시할 데이터가 있을 때만 렌더링
  if (!isRunning && !hasTodos && !hasAskQuestion && !hasStats) {
    return null
  }

  const statParts: string[] = []
  if (lastTurnStats?.inputTokens !== undefined) statParts.push(`${formatTokens(lastTurnStats.inputTokens)} 입력`)
  if (lastTurnStats?.outputTokens !== undefined) statParts.push(`${formatTokens(lastTurnStats.outputTokens)} 출력`)
  if (lastTurnStats?.costUsd !== undefined) statParts.push(`$${lastTurnStats.costUsd.toFixed(4)}`)
  if (lastTurnStats?.numTurns !== undefined) statParts.push(`${lastTurnStats.numTurns}턴`)

  return (
    <div className="border-t border-border bg-background/50 px-4 py-2">
      {/* 생각 중 인디케이터: todos/askQuestion 없을 때만 표시 */}
      {isRunning && !hasTodos && !hasAskQuestion && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          <span>응답 중...</span>
        </div>
      )}

      {/* Todo 체크리스트 */}
      {hasTodos && <TodoChecklist todos={todos} />}

      {/* 질문 */}
      {hasAskQuestion && askQuestion && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2 text-sm text-foreground">
            <Circle className="h-3.5 w-3.5 shrink-0 text-warning" />
            <span>{askQuestion.question}</span>
          </div>
          {askQuestion.options.length > 0 && (
            <div className="flex flex-wrap gap-1.5 pl-5">
              {askQuestion.options.map((opt, idx) => (
                <button
                  key={idx}
                  onClick={() => { sendResponse(`[AskUserQuestion] ${askQuestion.question} → ${opt}`); setAskQuestion(null) }}
                  className="rounded border border-[hsl(var(--primary)/0.5)] bg-[hsl(var(--primary)/0.1)] px-2 py-0.5 text-xs text-primary hover:bg-[hsl(var(--primary)/0.2)] hover:border-primary cursor-pointer transition-colors"
                >
                  {opt}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 턴 통계 */}
      {hasStats && statParts.length > 0 && (
        <div className="mt-1 text-xs text-muted-foreground">
          {statParts.join(' · ')}
        </div>
      )}

      {/* 세션 누적 비용 */}
      {turnHistory.length > 0 && (() => {
        const totalCost = turnHistory.reduce((sum, t) => sum + (t.costUsd ?? 0), 0)
        return (
          <div className="mt-0.5 text-xs text-dim-foreground">
            세션 누적: ${totalCost.toFixed(2)} ({turnHistory.length}턴)
          </div>
        )
      })()}
    </div>
  )
}
