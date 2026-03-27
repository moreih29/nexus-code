import { useState } from 'react'
import { NexusPanel } from '../plugins/NexusPanel'
import { AgentTimeline } from '../plugins/AgentTimeline'
import { MarkdownViewer } from '../plugins/MarkdownViewer'

type Tab = 'nexus' | 'markdown' | 'timeline'

const TABS: { id: Tab; label: string }[] = [
  { id: 'nexus', label: 'Nexus' },
  { id: 'markdown', label: 'Markdown' },
  { id: 'timeline', label: 'Timeline' },
]

export function RightPanel() {
  const [activeTab, setActiveTab] = useState<Tab>('nexus')

  return (
    <aside className="flex h-full w-[350px] shrink-0 flex-col border-l border-gray-800 bg-gray-900">
      {/* Tab bar */}
      <div className="flex h-12 shrink-0 items-center border-b border-gray-800">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={[
              'flex h-full flex-1 items-center justify-center text-xs font-medium transition-colors',
              activeTab === tab.id
                ? 'border-b-2 border-blue-500 text-blue-400'
                : 'text-gray-500 hover:text-gray-300',
            ].join(' ')}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="min-h-0 flex-1">
        {activeTab === 'nexus' && <NexusPanel />}
        {activeTab === 'markdown' && <MarkdownViewer />}
        {activeTab === 'timeline' && <AgentTimeline />}
      </div>
    </aside>
  )
}
