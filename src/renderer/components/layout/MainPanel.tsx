import { Loader2, Plus, X, AlertCircle, Clock } from 'lucide-react'
import { useSessionStore } from '../../stores/session-store'
import type { TabState } from '../../stores/session-store'
import { ChatPanel } from '../chat/ChatPanel'

function TabStatusIcon({ tab }: { tab: TabState }) {
  const { status } = tab
  if (status === 'running' || status === 'restarting') {
    return <Loader2 className="h-3 w-3 shrink-0 animate-spin text-blue-400" />
  }
  if (status === 'error') {
    return <AlertCircle className="h-3 w-3 shrink-0 text-red-400" />
  }
  if (status === 'timeout') {
    return <Clock className="h-3 w-3 shrink-0 text-yellow-400" />
  }
  return null
}

function TabBar() {
  const tabs = useSessionStore((s) => s.tabs)
  const tabOrder = useSessionStore((s) => s.tabOrder)
  const activeTabId = useSessionStore((s) => s.activeTabId)
  const addTab = useSessionStore((s) => s.addTab)
  const closeTab = useSessionStore((s) => s.closeTab)
  const switchTab = useSessionStore((s) => s.switchTab)
  const canAddTab = useSessionStore((s) => s.canAddTab())

  const getTabLabel = (tabId: string): string => {
    const tab = tabs[tabId]
    if (!tab) return '새 탭'
    const firstUserMsg = tab.messages.find((m) => m.role === 'user')
    if (!firstUserMsg) return '새 탭'
    return firstUserMsg.content.slice(0, 20) + (firstUserMsg.content.length > 20 ? '…' : '')
  }

  return (
    <div className="flex items-center border-b border-border bg-background">
      <div className="flex min-w-0 flex-1 items-center overflow-x-auto">
        {tabOrder.map((tabId) => {
          const isActive = tabId === activeTabId
          const tab = tabs[tabId]
          return (
            <button
              key={tabId}
              onClick={() => switchTab(tabId)}
              className={`group flex min-w-0 max-w-[180px] shrink-0 items-center gap-1.5 border-r border-border px-3 py-2 text-xs transition-colors ${
                isActive
                  ? 'bg-muted text-foreground'
                  : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
              }`}
            >
              {tab && <TabStatusIcon tab={tab} />}
              <span className="min-w-0 flex-1 truncate text-left">{getTabLabel(tabId)}</span>
              {tabOrder.length > 1 && (
                <span
                  role="button"
                  tabIndex={0}
                  onClick={(e) => {
                    e.stopPropagation()
                    closeTab(tabId)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.stopPropagation()
                      closeTab(tabId)
                    }
                  }}
                  className="shrink-0 rounded p-0.5 opacity-0 transition-opacity hover:bg-muted-foreground/20 group-hover:opacity-100"
                >
                  <X className="h-3 w-3" />
                </span>
              )}
            </button>
          )
        })}
      </div>
      <button
        onClick={canAddTab ? addTab : undefined}
        disabled={!canAddTab}
        className="shrink-0 p-2 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
        title={canAddTab ? '새 탭' : '최대 5개 탭까지 동시 실행 가능'}
      >
        <Plus className="h-4 w-4" />
      </button>
    </div>
  )
}

export function MainPanel() {
  return (
    <main className="flex h-full flex-1 flex-col bg-background">
      <TabBar />
      <ChatPanel />
    </main>
  )
}
