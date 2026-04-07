import { type MockSubagent } from '../../mock/data.js'
import { useChatStore } from '../../stores/chat-store.js'

const TYPE_BADGE_COLORS: Record<string, string> = {
  Explore: 'text-[#8b949e]',
  Engineer: 'text-[#bc8cff]',
  Researcher: 'text-[#58a6ff]',
  Writer: 'text-[#3fb950]',
  Tester: 'text-[#f0883e]',
}

interface SubagentCardProps {
  subagent: MockSubagent
}

export function SubagentCard({ subagent }: SubagentCardProps) {
  const { setActiveTab } = useChatStore()

  return (
    <button
      className="w-full text-left flex items-center gap-2 px-3 py-2 rounded-[4px] hover:bg-bg-hover transition-colors duration-150 cursor-pointer"
      style={{ background: 'var(--bg-elevated)' }}
      onClick={() => setActiveTab(subagent.id)}
    >
      {/* Status icon */}
      <span className="flex-shrink-0 flex items-center justify-center w-3 h-3">
        {subagent.status === 'running' && (
          <span
            className="w-3 h-3 rounded-full border-2 border-border"
            style={{
              borderTopColor: 'var(--green)',
              animation: 'spin 0.8s linear infinite',
            }}
          />
        )}
        {subagent.status === 'done' && (
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path
              d="M2 6L5 9L10 3"
              stroke="var(--green)"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )}
        {subagent.status === 'waiting_permission' && (
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path
              d="M6 1L11 10H1L6 1Z"
              stroke="var(--yellow)"
              strokeWidth="1.5"
              strokeLinejoin="round"
            />
            <path
              d="M6 5V7"
              stroke="var(--yellow)"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
            <circle cx="6" cy="8.5" r="0.5" fill="var(--yellow)" />
          </svg>
        )}
      </span>

      {/* Name */}
      <span className="text-[12px] font-semibold text-text-primary whitespace-nowrap">
        {subagent.name}
      </span>

      {/* Type badge */}
      <span
        className={`text-[10px] px-1.5 py-px rounded-full bg-bg-elevated border border-border ${TYPE_BADGE_COLORS[subagent.type] ?? 'text-text-muted'}`}
      >
        {subagent.type}
      </span>

      {/* Summary */}
      <span className="text-[11px] text-text-secondary truncate flex-1 min-w-0">
        {subagent.summary}
      </span>
    </button>
  )
}
