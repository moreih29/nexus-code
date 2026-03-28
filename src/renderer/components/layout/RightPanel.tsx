import { useState } from 'react'
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
  forceCollapsed?: boolean
}

export function RightPanel({ forceCollapsed = false }: RightPanelProps) {
  const activeTab = useRightPanelUIStore((s) => s.activeTab)
  const setActiveTab = useRightPanelUIStore((s) => s.setActiveTab)
  const [collapsed, setCollapsed] = useState(false)

  if (forceCollapsed) {
    return null
  }

  if (collapsed) {
    return (
      <aside className="flex h-full shrink-0 flex-col border-l border-border bg-card">
        <button
          onClick={() => setCollapsed(false)}
          className="flex h-12 w-10 items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
          title="패널 펼치기"
        >
          <PanelRightOpen className="h-4 w-4" />
        </button>
      </aside>
    )
  }

  return (
    <aside className="flex h-full w-[350px] shrink-0 flex-col border-l border-border bg-card">
      {/* Tab bar */}
      <div className="flex h-12 shrink-0 items-center border-b border-border">
        <button
          onClick={() => setCollapsed(true)}
          className="flex h-full w-10 items-center justify-center text-muted-foreground hover:text-foreground transition-colors shrink-0"
          title="패널 접기"
        >
          <PanelRightClose className="h-4 w-4" />
        </button>
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={[
              'flex h-full flex-1 items-center justify-center text-xs font-medium transition-colors',
              activeTab === tab.id
                ? 'border-b-2 border-blue-500 text-blue-400'
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
}
