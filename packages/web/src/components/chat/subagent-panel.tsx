import { useChatStore } from '../../stores/chat-store.js'
import { usePanelStore } from '../../stores/panel-store.js'
import { SubagentCard } from './subagent-card.js'

export function SubagentPanel() {
  const { subagents } = useChatStore()
  const { subagentPanelCollapsed, subagentPanelHidden, toggleSubagentPanel } = usePanelStore()

  if (subagents.length === 0 || subagentPanelHidden) {
    return null
  }

  const activeCount = subagents.filter(
    (sa) => sa.status === 'running' || sa.status === 'waiting_permission',
  ).length
  const totalCount = subagents.length

  return (
    <div
      className="flex-shrink-0 border-t border-border overflow-hidden transition-[max-height] duration-300 ease-in-out"
      style={{
        background: 'var(--bg-surface)',
        maxHeight: subagentPanelCollapsed ? '32px' : '200px',
      }}
    >
      {/* Header */}
      <button
        className="w-full flex items-center gap-2 px-4 py-1.5 text-[11px] text-text-secondary hover:bg-bg-hover transition-colors duration-150 cursor-pointer select-none"
        onClick={toggleSubagentPanel}
      >
        <span className="text-[11px] font-semibold text-text-primary">서브에이전트</span>
        <span className="text-[10px] bg-bg-elevated border border-border px-1.5 py-px rounded-full">
          {activeCount} 활성 / {totalCount} 전체
        </span>
        <span className="ml-auto text-[10px] text-text-muted">
          {subagentPanelCollapsed ? '▲' : '▼'}
        </span>
      </button>

      {/* Body */}
      {!subagentPanelCollapsed && (
        <div className="px-3 pb-2 flex flex-col gap-1">
          {subagents.map((sa) => (
            <SubagentCard key={sa.id} subagent={sa} />
          ))}
        </div>
      )}
    </div>
  )
}
