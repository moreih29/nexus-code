import { useState } from 'react'
import { FileText, Pencil, FileOutput, Terminal, Search, FolderSearch, Bot, Wrench } from 'lucide-react'
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

  function getGroupIcon(name: string) {
    switch (name) {
      case 'Read': return <FileText size={14} />
      case 'Edit': return <Pencil size={14} />
      case 'Write': return <FileOutput size={14} />
      case 'Bash': return <Terminal size={14} />
      case 'Grep': return <Search size={14} />
      case 'Glob': return <FolderSearch size={14} />
      case 'Agent':
      case 'Task': return <Bot size={14} />
      default: return <Wrench size={14} />
    }
  }

  const icon = getGroupIcon(group.name)

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
        <span className="flex-shrink-0 text-text-secondary">{icon}</span>
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
