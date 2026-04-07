import { useChatStore } from '../../stores/chat-store.js'

const TYPE_BADGE_COLORS: Record<string, string> = {
  Explore: 'text-[#8b949e]',
  Engineer: 'text-[#bc8cff]',
  Researcher: 'text-[#58a6ff]',
  Writer: 'text-[#3fb950]',
  Tester: 'text-[#f0883e]',
}

export function AgentTabs() {
  const activeTab = useChatStore((s) => s.activeTab)
  const setActiveTab = useChatStore((s) => s.setActiveTab)
  const subagents = useChatStore((s) => s.sessionState.subagents)

  return (
    <div
      className="flex items-center h-[38px] flex-shrink-0 px-2 gap-0.5 overflow-x-auto border-b border-border"
      style={{ background: 'var(--bg-surface)' }}
    >
      {/* Main tab */}
      <button
        className={[
          'flex items-center gap-1.5 px-3 py-[5px] text-[11.5px] font-semibold whitespace-nowrap',
          'rounded-t-[4px] border border-transparent border-b-0 transition-all duration-150',
          'relative cursor-pointer',
          activeTab === 'main'
            ? 'text-text-primary border-border bg-bg-base after:content-[\'\'] after:absolute after:bottom-[-1px] after:left-0 after:right-0 after:h-px after:bg-bg-base'
            : 'text-text-secondary hover:text-text-primary hover:bg-bg-hover',
        ].join(' ')}
        onClick={() => setActiveTab('main')}
      >
        메인 대화
      </button>

      {/* Separator */}
      {subagents.length > 0 && (
        <span className="w-px h-4 bg-border mx-1 flex-shrink-0" />
      )}

      {/* Subagent tabs */}
      {subagents.map((sa) => {
        const isActive = activeTab === sa.id
        const dotClass =
          sa.status === 'running'
            ? 'bg-green status-dot-running'
            : sa.status === 'waiting_permission'
              ? 'bg-yellow status-dot-waiting'
              : 'bg-text-muted'

        return (
          <button
            key={sa.id}
            className={[
              'flex items-center gap-1.5 px-3 py-[5px] text-[11.5px] whitespace-nowrap',
              'rounded-t-[4px] border border-transparent border-b-0 transition-all duration-150',
              'relative cursor-pointer',
              isActive
                ? 'text-text-primary border-border bg-bg-base after:content-[\'\'] after:absolute after:bottom-[-1px] after:left-0 after:right-0 after:h-px after:bg-bg-base'
                : 'text-text-secondary hover:text-text-primary hover:bg-bg-hover',
            ].join(' ')}
            onClick={() => setActiveTab(sa.id)}
          >
            <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${dotClass}`} />
            <span>{sa.name}</span>
            <span
              className={`text-[10px] -ml-0.5 ${TYPE_BADGE_COLORS[sa.type] ?? 'text-text-muted'}`}
            >
              {sa.type}
            </span>
          </button>
        )
      })}
    </div>
  )
}
