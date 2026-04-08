import { useState } from 'react'
import { TYPE_BADGE_COLORS } from '../../lib/subagent-theme.js'

interface SubagentResultBlockProps {
  name: string
  type: string
  summary: string
}

export function SubagentResultBlock({ name, type, summary }: SubagentResultBlockProps) {
  const [isOpen, setIsOpen] = useState(false)
  const typeColor = TYPE_BADGE_COLORS[type] ?? 'text-text-muted'

  return (
    <div
      className="rounded border border-border overflow-hidden"
      style={{ background: 'var(--bg-elevated)' }}
    >
      {/* Header */}
      <button
        className="w-full flex items-center gap-2 px-3 py-2 text-[12px] hover:bg-bg-hover transition-colors cursor-pointer text-left"
        onClick={() => setIsOpen((prev) => !prev)}
      >
        <span className="text-[13px] leading-none">🤖</span>
        <span className="font-semibold text-text-primary">{name}</span>
        <span className={`text-[11px] ${typeColor}`}>{type}</span>
        <span className="ml-auto flex items-center gap-1.5 flex-shrink-0">
          <span className="text-green text-[11px] font-medium">완료</span>
          <span className="text-text-muted text-[10px]">{isOpen ? '▲' : '▼'}</span>
        </span>
      </button>

      {/* Body */}
      {isOpen && (
        <div
          className="border-t border-border px-3 py-2 text-[11.5px] text-text-secondary whitespace-pre-wrap leading-[1.6]"
          style={{ background: 'var(--bg-surface)' }}
        >
          {summary}
        </div>
      )}
    </div>
  )
}
