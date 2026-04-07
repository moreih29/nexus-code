import { useState } from 'react'
import type { ToolCallState } from '../../adapters/session-adapter.js'
import { ToolBlock } from './tool-block.js'

interface ToolCallGroup {
  name: string
  items: ToolCallState[]
}

function groupConsecutive(toolCalls: ToolCallState[]): ToolCallGroup[] {
  const groups: ToolCallGroup[] = []
  for (const tc of toolCalls) {
    const last = groups[groups.length - 1]
    if (last && last.name === tc.name) {
      last.items.push(tc)
    } else {
      groups.push({ name: tc.name, items: [tc] })
    }
  }
  return groups
}

interface CollapsedGroupProps {
  group: ToolCallGroup
}

function CollapsedGroup({ group }: CollapsedGroupProps) {
  const [isExpanded, setIsExpanded] = useState(false)

  const TOOL_ICONS: Record<string, string> = {
    Read: '📖',
    Edit: '✏️',
    Write: '📝',
    Bash: '💻',
    Grep: '🔍',
    Glob: '🔍',
    Agent: '🤖',
  }

  const icon = TOOL_ICONS[group.name] ?? '🔧'

  const hasError = group.items.some((tc) => tc.isError || tc.status === 'error')
  const allDone = group.items.every((tc) => tc.status === 'success')
  const statusColor = hasError ? 'text-red' : allDone ? 'text-green' : 'text-yellow'

  return (
    <div
      className="rounded border border-border overflow-hidden"
      style={{ background: 'var(--bg-elevated)' }}
    >
      {/* Group header */}
      <button
        className="w-full flex items-center gap-2 px-3 py-2 text-[12px] hover:bg-bg-hover transition-colors cursor-pointer text-left"
        onClick={() => setIsExpanded((prev) => !prev)}
      >
        <span className="text-[13px] leading-none">{icon}</span>
        <span className="font-semibold text-text-primary">{group.name}</span>
        <span
          className="text-[10px] px-1.5 py-0.5 rounded font-medium"
          style={{ background: 'var(--bg-active)', color: 'var(--text-secondary)' }}
        >
          ×{group.items.length}
        </span>
        <span className={`ml-auto flex-shrink-0 text-[11px] font-medium ${statusColor}`}>
          {isExpanded ? '▲' : '▼'}
        </span>
      </button>

      {/* Expanded individual blocks */}
      {isExpanded && (
        <div className="border-t border-border flex flex-col gap-1 p-1.5" style={{ background: 'var(--bg-surface)' }}>
          {group.items.map((tc) => (
            <ToolBlock key={tc.id} toolCall={tc} />
          ))}
        </div>
      )}
    </div>
  )
}

interface ToolGroupProps {
  toolCalls: ToolCallState[]
}

export function ToolGroup({ toolCalls }: ToolGroupProps) {
  const groups = groupConsecutive(toolCalls)

  return (
    <div className="flex flex-col gap-1.5">
      {groups.map((group, idx) =>
        group.items.length >= 2 ? (
          <CollapsedGroup key={idx} group={group} />
        ) : (
          <ToolBlock key={group.items[0].id} toolCall={group.items[0]} />
        ),
      )}
    </div>
  )
}
