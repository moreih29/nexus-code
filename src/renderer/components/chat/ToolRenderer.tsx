import { useState } from 'react'
import type { ReactElement } from 'react'
import { ChevronRight, Loader2 } from 'lucide-react'
import type { ToolCallRecord } from '../../stores/session-store'
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '../ui/collapsible'
import { Badge } from '../ui/badge'
import { cn } from '../../lib/utils'

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

function CollapsibleResult({ result }: { result: string }) {
  const MAX = 10
  const { lines, total } = truncateLines(result, MAX)
  const [expanded, setExpanded] = useState(false)

  const displayLines = expanded ? result.split('\n') : lines
  const hasMore = total > MAX

  return (
    <div className="mt-2 border-t border-gray-700/50 pt-2">
      <pre className="whitespace-pre-wrap break-all font-mono text-gray-300">
        {displayLines.join('\n')}
      </pre>
      {hasMore && !expanded && (
        <button
          className="mt-1 text-gray-500 hover:text-gray-300 cursor-pointer"
          onClick={() => setExpanded(true)}
        >
          … {total - MAX} more lines
        </button>
      )}
      {hasMore && expanded && (
        <button
          className="mt-1 text-gray-500 hover:text-gray-300 cursor-pointer"
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
        className="border-blue-700/50 bg-blue-950/60 text-blue-300 gap-1"
        variant="outline"
      >
        <Loader2 className="size-3 animate-spin" />
        실행 중
      </Badge>
    )
  }
  if (status === 'error') {
    return (
      <Badge className="border-red-700/50 bg-red-950/60 text-red-300" variant="outline">
        에러
      </Badge>
    )
  }
  return (
    <Badge className="border-green-700/50 bg-green-950/60 text-green-300" variant="outline">
      완료
    </Badge>
  )
}

// ─── ToolCard ─────────────────────────────────────────────────────────────────

function ToolCard({
  name,
  status,
  icon,
  summary,
  children,
}: {
  name: string
  status: Status
  icon?: string
  summary?: string
  children: React.ReactNode
}) {
  // done 상태만 토글 가능, running/error는 강제 펼침
  const forcedOpen = status === 'running' || status === 'error'
  const [open, setOpen] = useState(forcedOpen)

  const handleOpenChange = (next: boolean) => {
    if (!forcedOpen) setOpen(next)
  }

  return (
    <Collapsible
      open={forcedOpen || open}
      onOpenChange={handleOpenChange}
      className={cn(
        'mt-2 rounded-lg border overflow-hidden',
        status === 'error'
          ? 'border-red-700/50 bg-red-950/30'
          : 'border-gray-700 bg-gray-800/40',
      )}
    >
      <CollapsibleTrigger asChild>
        <div
          className={cn(
            'flex items-center gap-2 px-3 py-1.5 border-b select-none',
            status === 'error' ? 'border-red-700/30' : 'border-gray-700/50',
            !forcedOpen && 'cursor-pointer hover:bg-gray-700/30',
          )}
        >
          {icon && <span className="shrink-0">{icon}</span>}
          <span className="font-mono text-xs text-blue-400 shrink-0">{name}</span>
          {summary && !(forcedOpen || open) && (
            <span className="text-xs text-gray-400 truncate min-w-0">{summary}</span>
          )}
          <span className="ml-auto flex items-center gap-1.5 shrink-0">
            <StatusBadge status={status} />
            {!forcedOpen && (
              <ChevronRight
                className={cn(
                  'size-3.5 text-gray-500 transition-transform duration-150',
                  open && 'rotate-90',
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
}

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

function BashRenderer({ tc }: { tc: ToolCallRecord }) {
  const command = str(tc.input.command)
  const description = tc.input.description ? str(tc.input.description) : undefined
  const status = resolveStatus(tc)

  return (
    <ToolCard name="Bash" status={status} icon="$" summary={bashSummary(tc)}>
      {description && <p className="text-gray-500 mb-1">{description}</p>}
      <pre className="font-mono text-gray-200 whitespace-pre-wrap break-all">
        <span className="text-gray-500">$ </span>
        {command}
      </pre>
      {tc.result !== undefined && <CollapsibleResult result={tc.result} />}
    </ToolCard>
  )
}

function ReadRenderer({ tc }: { tc: ToolCallRecord }) {
  const filePath = str(tc.input.file_path)
  const offset = tc.input.offset !== undefined ? Number(tc.input.offset) : undefined
  const limit = tc.input.limit !== undefined ? Number(tc.input.limit) : undefined
  const status = resolveStatus(tc)

  let range = ''
  if (offset !== undefined && limit !== undefined) range = ` (${offset}–${offset + limit})`
  else if (offset !== undefined) range = ` (from ${offset})`
  else if (limit !== undefined) range = ` (first ${limit})`

  return (
    <ToolCard name="Read" status={status} icon="📄" summary={readSummary(tc)}>
      <span className="font-mono text-gray-300">{filePath}</span>
      {range && <span className="text-gray-500">{range}</span>}
      {tc.result !== undefined && <CollapsibleResult result={tc.result} />}
    </ToolCard>
  )
}

function WriteRenderer({ tc }: { tc: ToolCallRecord }) {
  const filePath = str(tc.input.file_path)
  const status = resolveStatus(tc)
  const lineCount =
    tc.result !== undefined
      ? undefined
      : tc.input.content
        ? str(tc.input.content).split('\n').length
        : undefined

  return (
    <ToolCard name="Write" status={status} icon="✏️" summary={filePath}>
      <span className="font-mono text-gray-300">{filePath}</span>
      {lineCount !== undefined && (
        <p className="text-gray-500 mt-0.5">{lineCount} lines</p>
      )}
      {tc.result !== undefined && tc.result.length > 0 && (
        <CollapsibleResult result={tc.result} />
      )}
    </ToolCard>
  )
}

function truncateText(text: string, maxLines = 3): { preview: string; truncated: boolean } {
  const lines = text.split('\n')
  if (lines.length <= maxLines) return { preview: text, truncated: false }
  return { preview: lines.slice(0, maxLines).join('\n'), truncated: true }
}

function EditRenderer({ tc }: { tc: ToolCallRecord }) {
  const filePath = str(tc.input.file_path)
  const oldString = str(tc.input.old_string)
  const newString = str(tc.input.new_string)
  const status = resolveStatus(tc)

  const old_ = truncateText(oldString)
  const new_ = truncateText(newString)

  return (
    <ToolCard name="Edit" status={status} icon="✏️" summary={editSummary(tc)}>
      <span className="font-mono text-gray-300">{filePath}</span>
      <div className="mt-1.5 rounded border border-gray-700 overflow-hidden font-mono">
        <pre className="bg-red-950/40 px-2 py-1 text-red-300 whitespace-pre-wrap break-all">
          {old_.preview.split('\n').map((l, i) => (
            <span key={i} className="block">
              <span className="text-red-500 select-none">- </span>
              {l}
            </span>
          ))}
          {old_.truncated && <span className="text-gray-500">…</span>}
        </pre>
        <pre className="bg-green-950/40 px-2 py-1 text-green-300 whitespace-pre-wrap break-all">
          {new_.preview.split('\n').map((l, i) => (
            <span key={i} className="block">
              <span className="text-green-500 select-none">+ </span>
              {l}
            </span>
          ))}
          {new_.truncated && <span className="text-gray-500">…</span>}
        </pre>
      </div>
      {tc.result !== undefined && tc.result.length > 0 && (
        <CollapsibleResult result={tc.result} />
      )}
    </ToolCard>
  )
}

function GlobRenderer({ tc }: { tc: ToolCallRecord }) {
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
    <ToolCard name="Glob" status={status} icon="🔍" summary={globSummary(tc)}>
      <span className="font-mono text-gray-300">{pattern}</span>
      {path && <span className="text-gray-500"> in {path}</span>}
      {resultSummary && <p className="text-gray-400 mt-0.5">{resultSummary}</p>}
    </ToolCard>
  )
}

function GrepRenderer({ tc }: { tc: ToolCallRecord }) {
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
    <ToolCard name="Grep" status={status} icon="🔍" summary={grepSummary(tc)}>
      <span className="font-mono text-gray-300">"{pattern}"</span>
      {path && <span className="text-gray-500"> in {path}</span>}
      {resultSummary && <p className="text-gray-400 mt-0.5">{resultSummary}</p>}
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

function TodoWriteRenderer({ tc }: { tc: ToolCallRecord }) {
  const todos = Array.isArray(tc.input.todos) ? (tc.input.todos as TodoItem[]) : []
  const status = resolveStatus(tc)
  const summary = `${todos.length}개 항목`

  return (
    <ToolCard name="TodoWrite" status={status} icon="☑" summary={summary}>
      {todos.length === 0 && <span className="text-gray-500">no todos</span>}
      <ul className="space-y-0.5">
        {todos.map((todo, i) => {
          const icon = TODO_ICONS[todo.status ?? ''] ?? '☐'
          const label = todo.subject ?? todo.content ?? str(todo)
          return (
            <li key={i} className="flex items-start gap-1.5">
              <span className="shrink-0 text-gray-400">{icon}</span>
              <span className="text-gray-300">{label}</span>
              {todo.status && (
                <span className="ml-auto text-gray-600 shrink-0">{todo.status}</span>
              )}
            </li>
          )
        })}
      </ul>
    </ToolCard>
  )
}

function TaskRenderer({ tc }: { tc: ToolCallRecord }) {
  const subject = tc.input.subject ? str(tc.input.subject) : undefined
  const title = tc.input.title ? str(tc.input.title) : undefined
  const status = resolveStatus(tc)
  const summary = subject ?? title ?? ''

  return (
    <ToolCard name={tc.name} status={status} icon="📋" summary={summary}>
      {(subject ?? title) && (
        <span className="text-gray-300">"{subject ?? title}"</span>
      )}
      {tc.result !== undefined && tc.result.length > 0 && (
        <CollapsibleResult result={tc.result} />
      )}
    </ToolCard>
  )
}

function ToolSearchRenderer({ tc }: { tc: ToolCallRecord }) {
  const query = str(tc.input.query)
  const status = resolveStatus(tc)

  return (
    <ToolCard name="ToolSearch" status={status} icon="🔧" summary={`"${query}"`}>
      <span className="font-mono text-gray-300">"{query}"</span>
      {tc.result !== undefined && tc.result.length > 0 && (
        <CollapsibleResult result={tc.result} />
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

function AskRenderer({ tc }: { tc: ToolCallRecord }) {
  const questions = Array.isArray(tc.input.questions)
    ? (tc.input.questions as Array<{ question?: string; options?: unknown[] }>)
    : []
  const firstQ = questions[0]
  const question = firstQ?.question ?? str(tc.input.question)
  const options: unknown[] = firstQ?.options ?? []
  const status = resolveStatus(tc)

  return (
    <ToolCard name="AskUserQuestion" status={status} icon="❓" summary={question}>
      {question && <p className="text-gray-300">{question}</p>}
      {options.length > 0 && (
        <ul className="mt-1 space-y-0.5">
          {options.map((opt, i) => (
            <li key={i} className="flex items-center gap-1.5 text-gray-400">
              <span className="text-gray-600">○</span>
              {formatOption(opt)}
            </li>
          ))}
        </ul>
      )}
      {tc.result !== undefined && tc.result.length > 0 && (
        <CollapsibleResult result={tc.result} />
      )}
    </ToolCard>
  )
}

function AgentRenderer({ tc }: { tc: ToolCallRecord }) {
  const subagentType = tc.input.subagent_type ? str(tc.input.subagent_type) : undefined
  const prompt = tc.input.prompt ? str(tc.input.prompt) : undefined
  const { preview } = prompt ? truncateText(prompt, 2) : { preview: '' }
  const status = resolveStatus(tc)
  const summary = subagentType ?? ''

  return (
    <ToolCard name="Agent" status={status} icon="🤖" summary={summary}>
      {subagentType && (
        <p className="font-mono text-blue-300">{subagentType}</p>
      )}
      {preview && <p className="text-gray-400 mt-0.5 italic">"{preview}"</p>}
      {tc.result !== undefined && tc.result.length > 0 && (
        <CollapsibleResult result={tc.result} />
      )}
    </ToolCard>
  )
}

function WebSearchRenderer({ tc }: { tc: ToolCallRecord }) {
  const query = str(tc.input.query)
  const status = resolveStatus(tc)

  return (
    <ToolCard name="WebSearch" status={status} icon="🌐" summary={`"${query}"`}>
      <span className="font-mono text-gray-300">"{query}"</span>
      {tc.result !== undefined && tc.result.length > 0 && (
        <CollapsibleResult result={tc.result} />
      )}
    </ToolCard>
  )
}

function WebFetchRenderer({ tc }: { tc: ToolCallRecord }) {
  const url = str(tc.input.url)
  const status = resolveStatus(tc)

  return (
    <ToolCard name="WebFetch" status={status} icon="🌐" summary={url}>
      <span className="font-mono text-gray-300 break-all">{url}</span>
      {tc.result !== undefined && tc.result.length > 0 && (
        <CollapsibleResult result={tc.result} />
      )}
    </ToolCard>
  )
}

function GenericRenderer({ tc }: { tc: ToolCallRecord }) {
  const status = resolveStatus(tc)
  const inputStr = JSON.stringify(tc.input)
  const preview = inputStr.length > 120 ? inputStr.slice(0, 120) + '…' : inputStr

  return (
    <ToolCard name={tc.name} status={status} summary={preview}>
      <pre className="font-mono text-gray-400 whitespace-pre-wrap break-all">{preview}</pre>
      {tc.result !== undefined && tc.result.length > 0 && (
        <CollapsibleResult result={tc.result} />
      )}
    </ToolCard>
  )
}

// ─── dispatcher ───────────────────────────────────────────────────────────────

type Renderer = (props: { tc: ToolCallRecord }) => ReactElement

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

export function ToolRenderer({ tc }: { tc: ToolCallRecord }) {
  const Renderer = TOOL_RENDERERS[tc.name] ?? GenericRenderer
  return <Renderer tc={tc} />
}
