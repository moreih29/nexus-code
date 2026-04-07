import { usePanelStore } from '../../stores/panel-store'
import { FileTree } from './file-tree'
import { GitView } from './git-view'
import { BrowserView } from './browser-view'
import { EditorView } from './editor-view'

type RightTab = 'files' | 'git' | 'browser'

const tabs: { id: RightTab; label: string }[] = [
  { id: 'files', label: '📁 파일' },
  { id: 'git', label: '🔀 Git' },
  { id: 'browser', label: '🌐 브라우저' },
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
                  ? 'text-text-primary border-[#58a6ff]'
                  : 'text-text-secondary border-transparent hover:text-text-primary hover:bg-bg-hover',
              ].join(' ')}
              onClick={() => handleTabClick(tab.id)}
            >
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
