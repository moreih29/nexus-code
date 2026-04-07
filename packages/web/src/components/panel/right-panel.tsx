import type { ReactNode } from 'react'
import { FolderTree, GitBranch, Globe } from 'lucide-react'
import { usePanelStore } from '../../stores/panel-store'
import { FileTree } from './file-tree'
import { GitView } from './git-view'
import { BrowserView } from './browser-view'
import { EditorView } from './editor-view'

type RightTab = 'files' | 'git' | 'browser'

const tabs: { id: RightTab; label: string; icon: ReactNode }[] = [
  { id: 'files', label: '파일', icon: <FolderTree size={14} /> },
  { id: 'git', label: 'Git', icon: <GitBranch size={14} /> },
  { id: 'browser', label: '브라우저', icon: <Globe size={14} /> },
]

export function RightPanel() {
  const { rightTab, rightView, setRightTab } = usePanelStore()

  function handleTabClick(tab: RightTab) {
    setRightTab(tab)
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Tab bar */}
      <div className="flex h-9 border-b border-border flex-shrink-0">
        {tabs.map((tab) => {
          const isActive = rightView !== 'editor' && rightTab === tab.id
          return (
            <button
              key={tab.id}
              className={[
                'flex-1 flex items-center justify-center gap-1.5 text-[11px] cursor-pointer border-b-2 transition-colors',
                isActive
                  ? 'text-text-primary border-[var(--accent)]'
                  : 'text-text-secondary border-transparent hover:text-text-primary hover:bg-bg-hover',
              ].join(' ')}
              onClick={() => handleTabClick(tab.id)}
            >
              {tab.icon}
              {tab.label}
            </button>
          )
        })}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden flex flex-col">
        {rightView === 'editor' && <EditorView />}
        {rightView === 'files' && <FileTree />}
        {rightView === 'git' && <GitView />}
        {rightView === 'browser' && <BrowserView />}
      </div>
    </div>
  )
}
