import { memo, useState, useEffect } from 'react'
import type { ReactElement } from 'react'
import { ChevronRight, Loader2 } from 'lucide-react'
import type { ToolCallRecord } from '../../stores/session-store'
import type { ToolDensity } from '../../stores/settings-store'
import { useSettingsStore } from '../../stores/settings-store'
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '../ui/collapsible'
import { Badge } from '../ui/badge'
import { cn } from '../../lib/utils'
import { DiffView } from '../shared/DiffView'

// ─── shared helpers ──────────────────────────────────────────────────────────

function str(v: unknown): string {
  if (typeof v === 'string') return v
  if (v === null || v === undefined) return ''
  return JSON.stringify(v)
}

function truncateLines(text: string, maxLines: number): { lines: string[]; total: number } {
  const all = text.split('\n')
  return { lines: all.slice(0, maxLines), total: all.length }
}

// ─── CollapsibleResult ───────────────────────────────────────────────────────

function CollapsibleResult({ result, defaultExpanded = false }: { result: string; defaultExpanded?: boolean }) {
  const MAX = 10
  const { lines, total } = truncateLines(result, MAX)
  const [expanded, setExpanded] = useState(defaultExpanded)

  const displayLines = expanded ? result.split('\n') : lines
  const hasMore = total > MAX

  return (
    <div className="mt-2 border-t border-border/50 pt-2">
      <pre className="whitespace-pre-wrap break-all font-mono text-foreground">
        {displayLines.join('\n')}
      </pre>
      {hasMore && !expanded && (
        <button
          className="mt-1 text-muted-foreground hover:text-foreground cursor-pointer"
          onClick={() => setExpanded(true)}
        >
          … {total - MAX} more lines
        </button>
      )}
      {hasMore && expanded && (
        <button
          className="mt-1 text-muted-foreground hover:text-foreground cursor-pointer"
          onClick={() => setExpanded(false)}
        >
          collapse
        </button>
      )}
    </div>
  )
}

// ─── StatusBadge ─────────────────────────────────────────────────────────────

type Status = 'running' | 'done' | 'error'

function StatusBadge({ status }: { status: Status }) {
  if (status === 'running') {
    return (
      <Badge
        className="border-[hsl(var(--primary)/0.4)] bg-[hsl(var(--primary)/0.1)] text-[hsl(var(--primary))] gap-1"
        variant="outline"
      >
        <Loader2 className="size-3 animate-spin" />
        실행 중
      </Badge>
    )
  }
  if (status === 'error') {
    return (
      <Badge
        className="border-[hsl(var(--error)/0.4)] bg-[hsl(var(--error)/0.1)] text-[hsl(var(--error))]"
        variant="outline"
      >
        에러
      </Badge>
    )
  }
  return (
    <Badge
      className="border-[hsl(var(--success)/0.4)] bg-[hsl(var(--success)/0.1)] text-[hsl(var(--success))]"
      variant="outline"
    >
      완료
    </Badge>
  )
}

// ─── ToolCard ─────────────────────────────────────────────────────────────────

const ToolCard = memo(function ToolCard({
  name,
  status,
  icon,
  summary,
  density,
  children,
}: {
  name: string
  status: Status
  icon?: string
  summary?: string
  density: ToolDensity
  children: React.ReactNode
}) {
  // running/error는 항상 Normal 이상으로 강제 펼침
  const forcedOpen = status === 'running' || status === 'error'

  // compact + done → 인라인 한 줄 early return
  if (density === 'compact' && status === 'done') {
    return (
      <div className="mt-1 flex items-center gap-1.5 px-1 h-6 text-xs text-muted-foreground">
        {icon && <span className="shrink-0">{icon}</span>}
        <span className="font-mono text-[hsl(var(--primary))] shrink-0">{name}</span>
        {summary && (
          <span className="truncate min-w-0 text-dim-foreground">{summary}</span>
        )}
        <span className="ml-auto shrink-0">
          <StatusBadge status={status} />
        </span>
      </div>
    )
  }

  const [userToggled, setUserToggled] = useState(density === 'verbose')

  // status가 running/error → done으로 바뀌면 사용자 토글 초기화
  useEffect(() => {
    if (status === 'done') {
      setUserToggled(density === 'verbose')
    }
  }, [status, density])

  const isOpen = forcedOpen || (status === 'done' && userToggled)

  const handleOpenChange = (next: boolean) => {
    if (!forcedOpen) setUserToggled(next)
  }

  return (
    <Collapsible
      open={isOpen}
      onOpenChange={handleOpenChange}
      className={cn(
        'mt-2 rounded-lg border overflow-hidden',
        status === 'error'
          ? 'border-[hsl(var(--error)/0.4)] bg-[hsl(var(--error)/0.08)]'
          : 'border-border bg-muted/40',
      )}
    >
      <CollapsibleTrigger asChild>
        <div
          className={cn(
            'flex items-center gap-2 px-3 py-1.5 border-b select-none',
            status === 'error' ? 'border-[hsl(var(--error)/0.2)]' : 'border-border/50',
            !forcedOpen && 'cursor-pointer hover:bg-accent/30',
          )}
        >
          {icon && <span className="shrink-0">{icon}</span>}
          <span className="font-mono text-xs text-[hsl(var(--primary))] shrink-0">{name}</span>
          {summary && !isOpen && (
            <span className="text-xs text-muted-foreground truncate min-w-0">{summary}</span>
          )}
          <span className="ml-auto flex items-center gap-1.5 shrink-0">
            <StatusBadge status={status} />
            {!forcedOpen && (
              <ChevronRight
                className={cn(
                  'size-3.5 text-muted-foreground transition-transform duration-150',
                  isOpen && 'rotate-90',
                )}
              />
            )}
          </span>
        </div>
      </CollapsibleTrigger>
      <CollapsibleContent className="data-[state=closed]:animate-slideUp data-[state=open]:animate-slideDown">
        <div className="px-3 py-2 text-xs">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  )
})

function resolveStatus(tc: ToolCallRecord): Status {
  if (tc.result === undefined) return 'running'
  if (tc.isError) return 'error'
  return 'done'
}

// ─── one-line summaries ───────────────────────────────────────────────────────

function bashSummary(tc: ToolCallRecord): string {
  const cmd = str(tc.input.command)
  const firstLine = cmd.split('\n')[0]
  return `$ ${firstLine}`
}

function readSummary(tc: ToolCallRecord): string {
  const filePath = str(tc.input.file_path)
  if (tc.result !== undefined) {
    const lineCount = tc.result.split('\n').length
    return `${filePath} (${lineCount}줄)`
  }
  return filePath
}

function editSummary(tc: ToolCallRecord): string {
  return str(tc.input.file_path)
}

function globSummary(tc: ToolCallRecord): string {
  const pattern = str(tc.input.pattern)
  if (tc.result !== undefined) {
    const count = tc.result.trim() === '' ? 0 : tc.result.trim().split('\n').length
    return `${pattern} — ${count} files`
  }
  return pattern
}

function grepSummary(tc: ToolCallRecord): string {
  const pattern = str(tc.input.pattern)
  if (tc.result !== undefined) {
    const count = tc.result.trim() === '' ? 0 : tc.result.trim().split('\n').length
    return `"${pattern}" — ${count} matches`
  }
  return `"${pattern}"`
}

// ─── individual renderers ─────────────────────────────────────────────────────

function BashRenderer({ tc, density }: { tc: ToolCallRecord; density: ToolDensity }) {
  const command = str(tc.input.command)
  const description = tc.input.description ? str(tc.input.description) : undefined
  const status = resolveStatus(tc)

  return (
    <ToolCard name="Bash" status={status} icon="$" summary={bashSummary(tc)} density={density}>
      {description && <p className="text-muted-foreground mb-1">{description}</p>}
      <pre className="font-mono text-foreground whitespace-pre-wrap break-all">
        <span className="text-muted-foreground">$ </span>
        {command}
      </pre>
      {tc.result !== undefined && (
        <CollapsibleResult result={tc.result} defaultExpanded={density === 'verbose'} />
      )}
    </ToolCard>
  )
}

function ReadRenderer({ tc, density }: { tc: ToolCallRecord; density: ToolDensity }) {
  const filePath = str(tc.input.file_path)
  const offset = tc.input.offset !== undefined ? Number(tc.input.offset) : undefined
  const limit = tc.input.limit !== undefined ? Number(tc.input.limit) : undefined
  const status = resolveStatus(tc)

  let range = ''
  if (offset !== undefined && limit !== undefined) range = ` (${offset}–${offset + limit})`
  else if (offset !== undefined) range = ` (from ${offset})`
  else if (limit !== undefined) range = ` (first ${limit})`

  return (
    <ToolCard name="Read" status={status} icon="📄" summary={readSummary(tc)} density={density}>
      <span className="font-mono text-foreground">{filePath}</span>
      {range && <span className="text-muted-foreground">{range}</span>}
      {tc.result !== undefined && (
        <CollapsibleResult result={tc.result} defaultExpanded={density === 'verbose'} />
      )}
    </ToolCard>
  )
}

function WriteRenderer({ tc, density }: { tc: ToolCallRecord; density: ToolDensity }) {
  const filePath = str(tc.input.file_path)
  const status = resolveStatus(tc)
  const lineCount =
    tc.result !== undefined
      ? undefined
      : tc.input.content
        ? str(tc.input.content).split('\n').length
        : undefined

  return (
    <ToolCard name="Write" status={status} icon="✏️" summary={filePath} density={density}>
      <span className="font-mono text-foreground">{filePath}</span>
      {lineCount !== undefined && (
        <p className="text-muted-foreground mt-0.5">{lineCount} lines</p>
      )}
      {tc.result !== undefined && tc.result.length > 0 && (
        <CollapsibleResult result={tc.result} defaultExpanded={density === 'verbose'} />
      )}
    </ToolCard>
  )
}

function EditRenderer({ tc, density }: { tc: ToolCallRecord; density: ToolDensity }) {
  const filePath = str(tc.input.file_path)
  const oldString = str(tc.input.old_string)
  const newString = str(tc.input.new_string)
  const status = resolveStatus(tc)

  return (
    <ToolCard name="Edit" status={status} icon="✏️" summary={editSummary(tc)} density={density}>
      <span className="font-mono text-foreground">{filePath}</span>
      <div className="mt-1.5">
        <DiffView oldString={oldString} newString={newString} />
      </div>
      {tc.result !== undefined && tc.result.length > 0 && (
        <CollapsibleResult result={tc.result} defaultExpanded={density === 'verbose'} />
      )}
    </ToolCard>
  )
}

function GlobRenderer({ tc, density }: { tc: ToolCallRecord; density: ToolDensity }) {
  const pattern = str(tc.input.pattern)
  const path = tc.input.path ? str(tc.input.path) : undefined
  const status = resolveStatus(tc)

  const resultSummary =
    tc.result !== undefined
      ? tc.result.trim() === ''
        ? '0 files found'
        : `${tc.result.trim().split('\n').length} files found`
      : undefined

  return (
    <ToolCard name="Glob" status={status} icon="🔍" summary={globSummary(tc)} density={density}>
      <span className="font-mono text-foreground">{pattern}</span>
      {path && <span className="text-muted-foreground"> in {path}</span>}
      {resultSummary && <p className="text-muted-foreground mt-0.5">{resultSummary}</p>}
    </ToolCard>
  )
}

function GrepRenderer({ tc, density }: { tc: ToolCallRecord; density: ToolDensity }) {
  const pattern = str(tc.input.pattern)
  const path = tc.input.path ? str(tc.input.path) : undefined
  const status = resolveStatus(tc)

  const resultSummary =
    tc.result !== undefined
      ? tc.result.trim() === ''
        ? '0 matches'
        : `${tc.result.trim().split('\n').length} matches`
      : undefined

  return (
    <ToolCard name="Grep" status={status} icon="🔍" summary={grepSummary(tc)} density={density}>
      <span className="font-mono text-foreground">"{pattern}"</span>
      {path && <span className="text-muted-foreground"> in {path}</span>}
      {resultSummary && <p className="text-muted-foreground mt-0.5">{resultSummary}</p>}
    </ToolCard>
  )
}

interface TodoItem {
  id?: string
  content?: string
  subject?: string
  status?: string
  priority?: string
}

const TODO_ICONS: Record<string, string> = {
  completed: '☑',
  in_progress: '▶',
  pending: '☐',
}

function TodoWriteRenderer({ tc, density }: { tc: ToolCallRecord; density: ToolDensity }) {
  const todos = Array.isArray(tc.input.todos) ? (tc.input.todos as TodoItem[]) : []
  const status = resolveStatus(tc)
  const summary = `${todos.length}개 항목`

  return (
    <ToolCard name="TodoWrite" status={status} icon="☑" summary={summary} density={density}>
      {todos.length === 0 && <span className="text-muted-foreground">no todos</span>}
      <ul className="space-y-0.5">
        {todos.map((todo, i) => {
          const icon = TODO_ICONS[todo.status ?? ''] ?? '☐'
          const label = todo.subject ?? todo.content ?? str(todo)
          return (
            <li key={i} className="flex items-start gap-1.5">
              <span className="shrink-0 text-muted-foreground">{icon}</span>
              <span className="text-foreground">{label}</span>
              {todo.status && (
                <span className="ml-auto text-dim-foreground shrink-0">{todo.status}</span>
              )}
            </li>
          )
        })}
      </ul>
    </ToolCard>
  )
}

function TaskRenderer({ tc, density }: { tc: ToolCallRecord; density: ToolDensity }) {
  const subject = tc.input.subject ? str(tc.input.subject) : undefined
  const title = tc.input.title ? str(tc.input.title) : undefined
  const status = resolveStatus(tc)
  const summary = subject ?? title ?? ''

  return (
    <ToolCard name={tc.name} status={status} icon="📋" summary={summary} density={density}>
      {(subject ?? title) && (
        <span className="text-foreground">"{subject ?? title}"</span>
      )}
      {tc.result !== undefined && tc.result.length > 0 && (
        <CollapsibleResult result={tc.result} defaultExpanded={density === 'verbose'} />
      )}
    </ToolCard>
  )
}

function ToolSearchRenderer({ tc, density }: { tc: ToolCallRecord; density: ToolDensity }) {
  const query = str(tc.input.query)
  const status = resolveStatus(tc)

  return (
    <ToolCard name="ToolSearch" status={status} icon="🔧" summary={`"${query}"`} density={density}>
      <span className="font-mono text-foreground">"{query}"</span>
      {tc.result !== undefined && tc.result.length > 0 && (
        <CollapsibleResult result={tc.result} defaultExpanded={density === 'verbose'} />
      )}
    </ToolCard>
  )
}

function formatOption(opt: unknown): string {
  if (typeof opt === 'string') return opt
  if (opt && typeof opt === 'object') {
    const o = opt as Record<string, unknown>
    return o.label ? `${o.label}${o.description ? ` — ${o.description}` : ''}` : JSON.stringify(o)
  }
  return String(opt)
}

function AskRenderer({ tc, density }: { tc: ToolCallRecord; density: ToolDensity }) {
  const questions = Array.isArray(tc.input.questions)
    ? (tc.input.questions as Array<{ question?: string; options?: unknown[] }>)
    : []
  const firstQ = questions[0]
  const question = firstQ?.question ?? str(tc.input.question)
  const options: unknown[] = firstQ?.options ?? []
  const status = resolveStatus(tc)

  return (
    <ToolCard name="AskUserQuestion" status={status} icon="❓" summary={question} density={density}>
      {question && <p className="text-foreground">{question}</p>}
      {options.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {options.map((opt, i) => (
            <span
              key={i}
              className="rounded border border-border px-2.5 py-1 text-xs text-muted-foreground"
            >
              {formatOption(opt)}
            </span>
          ))}
        </div>
      )}
      {tc.result !== undefined && tc.result.length > 0 && (
        <CollapsibleResult result={tc.result} defaultExpanded={density === 'verbose'} />
      )}
    </ToolCard>
  )
}

function truncateText(text: string, maxLines = 3): { preview: string; truncated: boolean } {
  const lines = text.split('\n')
  if (lines.length <= maxLines) return { preview: text, truncated: false }
  return { preview: lines.slice(0, maxLines).join('\n'), truncated: true }
}

function AgentRenderer({ tc, density }: { tc: ToolCallRecord; density: ToolDensity }) {
  const subagentType = tc.input.subagent_type ? str(tc.input.subagent_type) : undefined
  const prompt = tc.input.prompt ? str(tc.input.prompt) : undefined
  const { preview } = prompt ? truncateText(prompt, 2) : { preview: '' }
  const status = resolveStatus(tc)
  const summary = subagentType ?? ''

  return (
    <ToolCard name="Agent" status={status} icon="🤖" summary={summary} density={density}>
      {subagentType && (
        <p className="font-mono text-[hsl(var(--primary))]">{subagentType}</p>
      )}
      {preview && <p className="text-muted-foreground mt-0.5 italic">"{preview}"</p>}
      {tc.result !== undefined && tc.result.length > 0 && (
        <CollapsibleResult result={tc.result} defaultExpanded={density === 'verbose'} />
      )}
    </ToolCard>
  )
}

function WebSearchRenderer({ tc, density }: { tc: ToolCallRecord; density: ToolDensity }) {
  const query = str(tc.input.query)
  const status = resolveStatus(tc)

  return (
    <ToolCard name="WebSearch" status={status} icon="🌐" summary={`"${query}"`} density={density}>
      <span className="font-mono text-foreground">"{query}"</span>
      {tc.result !== undefined && tc.result.length > 0 && (
        <CollapsibleResult result={tc.result} defaultExpanded={density === 'verbose'} />
      )}
    </ToolCard>
  )
}

function WebFetchRenderer({ tc, density }: { tc: ToolCallRecord; density: ToolDensity }) {
  const url = str(tc.input.url)
  const status = resolveStatus(tc)

  return (
    <ToolCard name="WebFetch" status={status} icon="🌐" summary={url} density={density}>
      <span className="font-mono text-foreground break-all">{url}</span>
      {tc.result !== undefined && tc.result.length > 0 && (
        <CollapsibleResult result={tc.result} defaultExpanded={density === 'verbose'} />
      )}
    </ToolCard>
  )
}

function GenericRenderer({ tc, density }: { tc: ToolCallRecord; density: ToolDensity }) {
  const status = resolveStatus(tc)
  const inputStr = JSON.stringify(tc.input)
  const preview = inputStr.length > 120 ? inputStr.slice(0, 120) + '…' : inputStr

  return (
    <ToolCard name={tc.name} status={status} summary={preview} density={density}>
      <pre className="font-mono text-muted-foreground whitespace-pre-wrap break-all">{preview}</pre>
      {tc.result !== undefined && tc.result.length > 0 && (
        <CollapsibleResult result={tc.result} defaultExpanded={density === 'verbose'} />
      )}
    </ToolCard>
  )
}

// ─── dispatcher ───────────────────────────────────────────────────────────────

type Renderer = (props: { tc: ToolCallRecord; density: ToolDensity }) => ReactElement

const TOOL_RENDERERS: Record<string, Renderer> = {
  Bash: BashRenderer,
  Read: ReadRenderer,
  Write: WriteRenderer,
  Edit: EditRenderer,
  MultiEdit: EditRenderer,
  Glob: GlobRenderer,
  Grep: GrepRenderer,
  TodoWrite: TodoWriteRenderer,
  TaskCreate: TaskRenderer,
  TaskUpdate: TaskRenderer,
  ToolSearch: ToolSearchRenderer,
  AskUserQuestion: AskRenderer,
  Agent: AgentRenderer,
  WebSearch: WebSearchRenderer,
  WebFetch: WebFetchRenderer,
}

export const ToolRenderer = memo(function ToolRenderer({ tc }: { tc: ToolCallRecord }) {
  const density = useSettingsStore((s) => s.toolDensity)
  const Renderer = TOOL_RENDERERS[tc.name] ?? GenericRenderer
  return <Renderer tc={tc} density={density} />
})
