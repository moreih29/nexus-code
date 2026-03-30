import { useEffect, useState } from 'react'
import { Check, Clock, Loader2, Minus } from 'lucide-react'
import { useStatusBarStore } from '../../stores/status-bar-store'
import type { TodoItem } from '../../stores/status-bar-store'
import { useWorkspaceStore } from '../../stores/workspace-store'
import { IpcChannel } from '../../../shared/ipc'
import type { NexusStateReadResponse, NexusStateChangedEvent } from '../../../shared/types'

// ─── 타입 정의 ─────────────────────────────────────────────────────────────

interface ConsultIssue {
  id?: string | number
  title?: string
  status?: string
  summary?: string
  timestamp?: string
  [key: string]: unknown
}

interface DecisionEntry {
  id?: string | number
  title?: string
  summary?: string
  decision?: string
  rationale?: string
  timestamp?: string
  consult?: string | number
  [key: string]: unknown
}

interface TaskEntry {
  id?: string | number
  title?: string
  subject?: string
  status?: string
  owner?: string
  timestamp?: string
  [key: string]: unknown
}

type TimelineItemType = 'consult' | 'decision' | 'task'

interface TimelineItem {
  type: TimelineItemType
  timestamp: number
  data: ConsultIssue | DecisionEntry | TaskEntry
}

// ─── 유틸리티 ──────────────────────────────────────────────────────────────

function parseTimestamp(ts: string | undefined, fallback: number): number {
  if (!ts) return fallback
  const parsed = Date.parse(ts)
  return isNaN(parsed) ? fallback : parsed
}

// ─── 카드 컴포넌트 ─────────────────────────────────────────────────────────

const CONSULT_STATUS: Record<string, { label: string; className: string }> = {
  pending:    { label: 'pending',    className: 'bg-muted text-muted-foreground' },
  discussing: { label: 'discussing', className: 'bg-warning/20 text-warning' },
  decided:    { label: 'decided',    className: 'bg-success/20 text-success' },
}

function ConsultCard({ data }: { data: ConsultIssue }) {
  const statusInfo = CONSULT_STATUS[data.status ?? ''] ?? CONSULT_STATUS.pending
  return (
    <div className="rounded border border-border bg-muted/30 p-2.5 space-y-1.5">
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold text-dim-foreground uppercase tracking-wide">Consult</span>
        <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${statusInfo.className}`}>
          {statusInfo.label}
        </span>
      </div>
      {data.title && (
        <p className="text-sm font-medium text-foreground">{data.title}</p>
      )}
      {data.summary && (
        <p className="text-xs text-muted-foreground">{data.summary}</p>
      )}
    </div>
  )
}

function DecisionCard({ data }: { data: DecisionEntry }) {
  return (
    <div className="rounded border border-border bg-muted/30 p-2.5 space-y-1.5">
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold text-dim-foreground uppercase tracking-wide">Decision</span>
        {data.consult !== undefined && (
          <span className="text-xs text-muted-foreground">이슈 #{String(data.consult)}에서</span>
        )}
      </div>
      <p className="text-sm font-medium text-foreground">
        {data.title ?? data.summary ?? data.decision ?? '결정 사항'}
      </p>
      {data.rationale && (
        <p className="text-xs text-muted-foreground">{data.rationale}</p>
      )}
    </div>
  )
}

const TASK_STATUS_ICON: Record<string, React.ReactNode> = {
  completed:   <Check className="h-3.5 w-3.5 shrink-0 text-success" />,
  in_progress: <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />,
  pending:     <Minus className="h-3.5 w-3.5 shrink-0 text-dim-foreground" />,
}

function TaskCard({ data }: { data: TaskEntry }) {
  const icon = TASK_STATUS_ICON[data.status ?? ''] ?? TASK_STATUS_ICON.pending
  return (
    <div className="rounded border border-border bg-muted/30 p-2.5">
      <div className="flex items-start gap-2">
        <span className="mt-0.5">{icon}</span>
        <span className="flex-1 text-sm text-foreground">{data.title ?? data.subject ?? `Task #${String(data.id ?? '?')}`}</span>
        {data.owner && (
          <span className="shrink-0 text-xs text-dim-foreground">{String(data.owner)}</span>
        )}
      </div>
    </div>
  )
}

function TodoCard({ todo }: { todo: TodoItem }) {
  return (
    <div className="flex items-start gap-2 rounded px-1 py-1 hover:bg-muted/40">
      {todo.status === 'completed' ? (
        <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" />
      ) : todo.status === 'in_progress' ? (
        <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
      ) : (
        <Minus className="mt-0.5 h-3.5 w-3.5 shrink-0 text-dim-foreground" />
      )}
      <span
        className={`text-xs ${
          todo.status === 'completed'
            ? 'text-dim-foreground line-through'
            : todo.status === 'in_progress'
              ? 'text-foreground'
              : 'text-muted-foreground'
        }`}
      >
        {todo.content}
      </span>
    </div>
  )
}

// ─── 타임라인 구성 ─────────────────────────────────────────────────────────

function buildTimeline(
  consultRaw: unknown,
  decisionsRaw: unknown,
  tasksRaw: unknown,
): TimelineItem[] {
  const items: TimelineItem[] = []
  let syntheticBase = Date.now()

  // Consult 이슈 정규화
  const consultIssues: ConsultIssue[] = Array.isArray(consultRaw)
    ? (consultRaw as ConsultIssue[])
    : consultRaw && typeof consultRaw === 'object' && 'issues' in (consultRaw as object)
      ? ((consultRaw as { issues: ConsultIssue[] }).issues ?? [])
      : consultRaw && typeof consultRaw === 'object'
        ? [consultRaw as ConsultIssue]
        : []

  consultIssues.forEach((issue, i) => {
    items.push({
      type: 'consult',
      timestamp: parseTimestamp(issue.timestamp, syntheticBase + i),
      data: issue,
    })
  })

  // Decisions 정규화
  const decisionEntries: DecisionEntry[] = Array.isArray(decisionsRaw)
    ? (decisionsRaw as DecisionEntry[])
    : decisionsRaw && typeof decisionsRaw === 'object' && 'decisions' in (decisionsRaw as object)
      ? ((decisionsRaw as { decisions: DecisionEntry[] }).decisions ?? [])
      : []

  syntheticBase += 1000
  decisionEntries.forEach((d, i) => {
    items.push({
      type: 'decision',
      timestamp: parseTimestamp(d.timestamp, syntheticBase + i),
      data: d,
    })
  })

  // Tasks 정규화
  const taskEntries: TaskEntry[] = Array.isArray(tasksRaw)
    ? (tasksRaw as TaskEntry[])
    : tasksRaw && typeof tasksRaw === 'object' && 'tasks' in (tasksRaw as object)
      ? ((tasksRaw as { tasks: TaskEntry[] }).tasks ?? [])
      : []

  syntheticBase += 1000
  taskEntries.forEach((t, i) => {
    items.push({
      type: 'task',
      timestamp: parseTimestamp(t.timestamp, syntheticBase + i),
      data: t,
    })
  })

  // timestamp 기준 정렬
  items.sort((a, b) => a.timestamp - b.timestamp)
  return items
}

// ─── NexusPanel (메인) ─────────────────────────────────────────────────────

export function NexusPanel() {
  const todos = useStatusBarStore((s) => s.todos)
  const activeWorkspace = useWorkspaceStore((s) => s.activeWorkspace)
  const [nexusState, setNexusState] = useState<NexusStateReadResponse>({ consult: null, decisions: null, tasks: null })

  useEffect(() => {
    if (!activeWorkspace) {
      setNexusState({ consult: null, decisions: null, tasks: null })
      return
    }

    // 초기 로드
    window.electronAPI.invoke(IpcChannel.NEXUS_STATE_READ, { cwd: activeWorkspace })
      .then(setNexusState)
      .catch(() => {})

    // 변경 감시
    const handler = (...args: unknown[]) => {
      const event = args[0] as NexusStateChangedEvent
      if (event.cwd === activeWorkspace) {
        setNexusState({ consult: event.consult, decisions: event.decisions, tasks: event.tasks })
      }
    }
    window.electronAPI.on(IpcChannel.NEXUS_STATE_CHANGED, handler)
    return () => { window.electronAPI.off(IpcChannel.NEXUS_STATE_CHANGED, handler) }
  }, [activeWorkspace])

  const timeline = buildTimeline(nexusState.consult, nexusState.decisions, nexusState.tasks)
  const hasTodos = todos.length > 0
  const hasTimeline = timeline.length > 0

  return (
    <div className="flex h-full flex-col overflow-y-auto p-3 gap-3">
      {/* 실행 중 todo (상단 고정) */}
      {hasTodos && (
        <section>
          <p className="mb-1 text-xs font-semibold text-muted-foreground uppercase tracking-wide">실행 중</p>
          <div className="space-y-0.5">
            {todos.map((todo, i) => (
              <TodoCard key={i} todo={todo} />
            ))}
          </div>
        </section>
      )}

      {/* 통합 타임라인 */}
      {hasTimeline ? (
        <section className="space-y-2">
          {hasTodos && (
            <div className="border-t border-border pt-2">
              <p className="mb-2 text-xs font-semibold text-muted-foreground uppercase tracking-wide">타임라인</p>
            </div>
          )}
          {!hasTodos && (
            <p className="mb-1 text-xs font-semibold text-muted-foreground uppercase tracking-wide">타임라인</p>
          )}
          {timeline.map((item, i) => (
            <div key={i}>
              {item.type === 'consult' && <ConsultCard data={item.data as ConsultIssue} />}
              {item.type === 'decision' && <DecisionCard data={item.data as DecisionEntry} />}
              {item.type === 'task' && <TaskCard data={item.data as TaskEntry} />}
            </div>
          ))}
        </section>
      ) : (
        !hasTodos && (
          <div className="flex flex-1 items-center justify-center">
            <div className="flex flex-col items-center gap-2 text-dim-foreground">
              <Clock className="h-8 w-8 opacity-30" />
              <p className="text-xs">Nexus 데이터 없음</p>
            </div>
          </div>
        )
      )}
    </div>
  )
}
