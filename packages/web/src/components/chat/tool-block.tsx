import { useState } from 'react'
import type { MockToolCall } from '../../mock/data.js'
import { DiffView } from './diff-view.js'

const TOOL_ICONS: Record<string, string> = {
  Read: '📖',
  Edit: '✏️',
  Write: '📝',
  Bash: '💻',
  Grep: '🔍',
  Glob: '🔍',
  Agent: '🤖',
}

function getToolIcon(name: string): string {
  return TOOL_ICONS[name] ?? '🔧'
}

function getFilePath(input: Record<string, unknown>): string | null {
  const path = input.file_path ?? input.path ?? input.command
  if (typeof path === 'string') return path
  return null
}

function shouldDefaultExpand(toolName: string, isError: boolean): boolean {
  if (isError) return true
  return toolName === 'Edit' || toolName === 'Write'
}

function isDiffResult(toolName: string, result: string | undefined): boolean {
  if (!result) return false
  if (toolName !== 'Edit' && toolName !== 'Write') return false
  return result.includes('\n') && (result.includes('+') || result.includes('-'))
}

interface ToolBlockProps {
  toolCall: MockToolCall
}

export function ToolBlock({ toolCall }: ToolBlockProps) {
  const defaultOpen = shouldDefaultExpand(toolCall.name, toolCall.isError ?? false)
  const [isOpen, setIsOpen] = useState(defaultOpen)

  const filePath = getFilePath(toolCall.input)
  const icon = getToolIcon(toolCall.name)

  const statusColor =
    toolCall.status === 'success'
      ? 'text-green'
      : toolCall.status === 'error'
        ? 'text-red'
        : 'text-yellow'

  const statusLabel =
    toolCall.status === 'success' ? '완료' : toolCall.status === 'error' ? '오류' : '실행 중'

  const hasDiff = isDiffResult(toolCall.name, toolCall.result)
  const hasBody = toolCall.result !== undefined

  return (
    <div
      className="rounded border border-border overflow-hidden"
      style={{ background: 'var(--bg-elevated)' }}
    >
      {/* Header */}
      <button
        className="w-full flex items-center gap-2 px-3 py-2 text-[12px] hover:bg-bg-hover transition-colors cursor-pointer text-left"
        onClick={() => hasBody && setIsOpen((prev) => !prev)}
        disabled={!hasBody}
      >
        <span className="text-[13px] leading-none">{icon}</span>
        <span className="font-semibold text-text-primary">{toolCall.name}</span>
        {filePath && (
          <span className="text-text-muted font-mono text-[11px] truncate min-w-0 flex-1">
            {filePath}
          </span>
        )}
        <span className={`ml-auto flex-shrink-0 text-[11px] font-medium ${statusColor}`}>
          {toolCall.status === 'running' && (
            <span
              className="inline-block w-2.5 h-2.5 rounded-full border-2 border-border mr-1 flex-shrink-0"
              style={{ borderTopColor: 'var(--green)', animation: 'spin .8s linear infinite' }}
            />
          )}
          {statusLabel}
        </span>
        {hasBody && (
          <span className="text-text-muted text-[10px] ml-1 flex-shrink-0">
            {isOpen ? '▲' : '▼'}
          </span>
        )}
      </button>

      {/* Body */}
      {isOpen && hasBody && (
        <div
          className="border-t border-border"
          style={{ background: 'var(--bg-surface)' }}
        >
          {hasDiff ? (
            <DiffView result={toolCall.result!} />
          ) : (
            <div className="px-3 py-2 text-[11px] text-text-secondary font-mono whitespace-pre-wrap">
              {toolCall.result}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
