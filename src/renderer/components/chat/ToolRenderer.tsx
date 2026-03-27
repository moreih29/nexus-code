import { useState } from 'react'
import type { ToolCallRecord } from '../../stores/session-store'

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

function CollapsibleResult({ result }: { result: string }): JSX.Element {
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

// ─── ToolCard ─────────────────────────────────────────────────────────────────

type Status = 'running' | 'done' | 'error'

function ToolCard({
  name,
  status,
  icon,
  children,
}: {
  name: string
  status: Status
  icon?: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <div className="mt-2 rounded-lg border border-gray-700 bg-gray-800/40 overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-gray-700/50">
        {icon && <span>{icon}</span>}
        <span className="font-mono text-xs text-blue-400">{name}</span>
        <span className="ml-auto">
          {status === 'running' && (
            <span className="animate-pulse text-xs text-gray-500">running…</span>
          )}
          {status === 'done' && <span className="text-xs text-green-400">done</span>}
          {status === 'error' && <span className="text-xs text-red-400">error</span>}
        </span>
      </div>
      <div className="px-3 py-2 text-xs">{children}</div>
    </div>
  )
}

function resolveStatus(tc: ToolCallRecord): Status {
  if (tc.result === undefined) return 'running'
  if (tc.isError) return 'error'
  return 'done'
}

// ─── individual renderers ─────────────────────────────────────────────────────

function BashRenderer({ tc }: { tc: ToolCallRecord }): JSX.Element {
  const command = str(tc.input.command)
  const description = tc.input.description ? str(tc.input.description) : undefined
  const status = resolveStatus(tc)

  return (
    <ToolCard name="Bash" status={status} icon="$">
      {description && <p className="text-gray-500 mb-1">{description}</p>}
      <pre className="font-mono text-gray-200 whitespace-pre-wrap break-all">
        <span className="text-gray-500">$ </span>
        {command}
      </pre>
      {tc.result !== undefined && <CollapsibleResult result={tc.result} />}
    </ToolCard>
  )
}

function ReadRenderer({ tc }: { tc: ToolCallRecord }): JSX.Element {
  const filePath = str(tc.input.file_path)
  const offset = tc.input.offset !== undefined ? Number(tc.input.offset) : undefined
  const limit = tc.input.limit !== undefined ? Number(tc.input.limit) : undefined
  const status = resolveStatus(tc)

  let range = ''
  if (offset !== undefined && limit !== undefined) range = ` (${offset}–${offset + limit})`
  else if (offset !== undefined) range = ` (from ${offset})`
  else if (limit !== undefined) range = ` (first ${limit})`

  return (
    <ToolCard name="Read" status={status} icon="📄">
      <span className="font-mono text-gray-300">{filePath}</span>
      {range && <span className="text-gray-500">{range}</span>}
      {tc.result !== undefined && <CollapsibleResult result={tc.result} />}
    </ToolCard>
  )
}

function WriteRenderer({ tc }: { tc: ToolCallRecord }): JSX.Element {
  const filePath = str(tc.input.file_path)
  const status = resolveStatus(tc)
  const lineCount =
    tc.result !== undefined
      ? undefined
      : tc.input.content
        ? str(tc.input.content).split('\n').length
        : undefined

  return (
    <ToolCard name="Write" status={status} icon="✏️">
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

function EditRenderer({ tc }: { tc: ToolCallRecord }): JSX.Element {
  const filePath = str(tc.input.file_path)
  const oldString = str(tc.input.old_string)
  const newString = str(tc.input.new_string)
  const status = resolveStatus(tc)

  const old_ = truncateText(oldString)
  const new_ = truncateText(newString)

  return (
    <ToolCard name="Edit" status={status} icon="✏️">
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

function GlobRenderer({ tc }: { tc: ToolCallRecord }): JSX.Element {
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
    <ToolCard name="Glob" status={status} icon="🔍">
      <span className="font-mono text-gray-300">{pattern}</span>
      {path && <span className="text-gray-500"> in {path}</span>}
      {resultSummary && <p className="text-gray-400 mt-0.5">{resultSummary}</p>}
    </ToolCard>
  )
}

function GrepRenderer({ tc }: { tc: ToolCallRecord }): JSX.Element {
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
    <ToolCard name="Grep" status={status} icon="🔍">
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

function TodoWriteRenderer({ tc }: { tc: ToolCallRecord }): JSX.Element {
  const todos = Array.isArray(tc.input.todos) ? (tc.input.todos as TodoItem[]) : []
  const status = resolveStatus(tc)

  return (
    <ToolCard name="TodoWrite" status={status} icon="☑">
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

function TaskRenderer({ tc }: { tc: ToolCallRecord }): JSX.Element {
  const subject = tc.input.subject ? str(tc.input.subject) : undefined
  const title = tc.input.title ? str(tc.input.title) : undefined
  const status = resolveStatus(tc)

  return (
    <ToolCard name={tc.name} status={status} icon="📋">
      {(subject ?? title) && (
        <span className="text-gray-300">"{subject ?? title}"</span>
      )}
      {tc.result !== undefined && tc.result.length > 0 && (
        <CollapsibleResult result={tc.result} />
      )}
    </ToolCard>
  )
}

function ToolSearchRenderer({ tc }: { tc: ToolCallRecord }): JSX.Element {
  const query = str(tc.input.query)
  const status = resolveStatus(tc)

  return (
    <ToolCard name="ToolSearch" status={status} icon="🔧">
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

function AskRenderer({ tc }: { tc: ToolCallRecord }): JSX.Element {
  const questions = Array.isArray(tc.input.questions)
    ? (tc.input.questions as Array<{ question?: string; options?: unknown[] }>)
    : []
  const firstQ = questions[0]
  const question = firstQ?.question ?? str(tc.input.question)
  const options: unknown[] = firstQ?.options ?? []
  const status = resolveStatus(tc)

  return (
    <ToolCard name="AskUserQuestion" status={status} icon="❓">
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

function AgentRenderer({ tc }: { tc: ToolCallRecord }): JSX.Element {
  const subagentType = tc.input.subagent_type ? str(tc.input.subagent_type) : undefined
  const prompt = tc.input.prompt ? str(tc.input.prompt) : undefined
  const { preview } = prompt ? truncateText(prompt, 2) : { preview: '' }
  const status = resolveStatus(tc)

  return (
    <ToolCard name="Agent" status={status} icon="🤖">
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

function WebSearchRenderer({ tc }: { tc: ToolCallRecord }): JSX.Element {
  const query = str(tc.input.query)
  const status = resolveStatus(tc)

  return (
    <ToolCard name="WebSearch" status={status} icon="🌐">
      <span className="font-mono text-gray-300">"{query}"</span>
      {tc.result !== undefined && tc.result.length > 0 && (
        <CollapsibleResult result={tc.result} />
      )}
    </ToolCard>
  )
}

function WebFetchRenderer({ tc }: { tc: ToolCallRecord }): JSX.Element {
  const url = str(tc.input.url)
  const status = resolveStatus(tc)

  return (
    <ToolCard name="WebFetch" status={status} icon="🌐">
      <span className="font-mono text-gray-300 break-all">{url}</span>
      {tc.result !== undefined && tc.result.length > 0 && (
        <CollapsibleResult result={tc.result} />
      )}
    </ToolCard>
  )
}

function GenericRenderer({ tc }: { tc: ToolCallRecord }): JSX.Element {
  const status = resolveStatus(tc)
  const inputStr = JSON.stringify(tc.input)
  const preview = inputStr.length > 120 ? inputStr.slice(0, 120) + '…' : inputStr

  return (
    <ToolCard name={tc.name} status={status}>
      <pre className="font-mono text-gray-400 whitespace-pre-wrap break-all">{preview}</pre>
      {tc.result !== undefined && tc.result.length > 0 && (
        <CollapsibleResult result={tc.result} />
      )}
    </ToolCard>
  )
}

// ─── dispatcher ───────────────────────────────────────────────────────────────

type Renderer = (props: { tc: ToolCallRecord }) => JSX.Element

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

export function ToolRenderer({ tc }: { tc: ToolCallRecord }): JSX.Element {
  const Renderer = TOOL_RENDERERS[tc.name] ?? GenericRenderer
  return <Renderer tc={tc} />
}
