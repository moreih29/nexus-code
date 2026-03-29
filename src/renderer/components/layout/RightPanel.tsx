import { memo } from 'react'
import { PanelRightClose, PanelRightOpen } from 'lucide-react'
import { NexusPanel } from '../plugins/NexusPanel'
import { AgentTimeline } from '../plugins/AgentTimeline'
import { MarkdownViewer } from '../plugins/MarkdownViewer'
import { ChangesPanel } from '../plugins/ChangesPanel'
import { useRightPanelUIStore, type RightPanelTab } from '../../stores/plugin-store'

type Tab = RightPanelTab

const TABS: { id: Tab; label: string }[] = [
  { id: 'nexus', label: 'Nexus' },
  { id: 'changes', label: 'Changes' },
  { id: 'markdown', label: 'Markdown' },
  { id: 'timeline', label: 'Timeline' },
]

interface RightPanelProps {
  onToggle?: () => void
  isCollapsed?: boolean
}

export const RightPanel = memo(function RightPanel({ onToggle, isCollapsed }: RightPanelProps) {
  const activeTab = useRightPanelUIStore((s) => s.activeTab)
  const pinTab = useRightPanelUIStore((s) => s.pinTab)

  if (isCollapsed) {
    return (
      <aside className="flex h-full w-full flex-col items-center border-l border-border bg-card py-2">
        <button
          onClick={onToggle}
          className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          title="패널 열기"
        >
          <PanelRightOpen size={18} />
        </button>
      </aside>
    )
  }

  return (
    <aside className="flex h-full flex-col border-l border-border bg-card">
      {/* Tab bar */}
      <div className="flex h-12 shrink-0 items-center border-b border-border">
        <button
          onClick={onToggle}
          className="flex h-full w-10 items-center justify-center text-muted-foreground hover:text-foreground transition-colors shrink-0"
          title="패널 접기"
        >
          <PanelRightClose className="h-4 w-4" />
        </button>
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => pinTab(tab.id)}
            className={[
              'flex h-full flex-1 items-center justify-center text-xs font-medium transition-colors',
              activeTab === tab.id
                ? 'border-b-2 border-primary text-primary'
                : 'text-muted-foreground hover:text-foreground',
            ].join(' ')}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="min-h-0 flex-1">
        {activeTab === 'nexus' && <NexusPanel />}
        {activeTab === 'changes' && <ChangesPanel />}
        {activeTab === 'markdown' && <MarkdownViewer />}
        {activeTab === 'timeline' && <AgentTimeline />}
      </div>
    </aside>
  )
})
