import { useCallback } from 'react'
import { AgentSidebar } from '../agent/AgentSidebar'
import { ApprovalQueue } from '../permission/ApprovalQueue'
import { ContextBar } from './ContextBar'
import { ChatPanel } from '../chat/ChatPanel'
import { useContextStore } from '../../stores/context-store'
import { useWorkspaceStore } from '../../stores/workspace-store'
import { SessionStoreContext, getOrCreateWorkspaceStore } from '../../stores/session-store'

interface MissionControlLayoutProps {
  bottomPanelVisible: boolean
  onBottomPanelVisibleChange: (visible: boolean) => void
}

export function MissionControlLayout({
  bottomPanelVisible: _bottomPanelVisible,
  onBottomPanelVisibleChange: _onBottomPanelVisibleChange,
}: MissionControlLayoutProps) {
  const activeWorkspace = useWorkspaceStore((s) => s.activeWorkspace)
  const selectAgents = useContextStore((s) => s.selectAgents)
  const setFilterMode = useContextStore((s) => s.setFilterMode)

  const handleAgentSelect = useCallback(
    (agentId: string) => {
      selectAgents([agentId])
      setFilterMode('agent')
    },
    [selectAgents, setFilterMode],
  )

  return (
    <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
      {/* 왼쪽: AgentSidebar (20%) */}
      <div className="flex h-full w-[20%] min-w-[200px] max-w-[320px] flex-shrink-0 flex-col overflow-hidden border-r border-border">
        <div className="border-b border-border px-3 py-2">
          <span className="text-xs font-medium text-muted-foreground">에이전트</span>
        </div>
        <AgentSidebar
          sessionId={activeWorkspace ?? null}
          onAgentSelect={handleAgentSelect}
        />
      </div>

      {/* 가운데: ApprovalQueue (35%) */}
      <div className="flex h-full min-w-0 flex-[35] flex-col overflow-hidden border-r border-border">
        <div className="border-b border-border px-3 py-2">
          <span className="text-xs font-medium text-muted-foreground">승인 큐</span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <ApprovalQueue />
        </div>
      </div>

      {/* 오른쪽: ContextBar + Chat (45%) */}
      <div className="flex h-full min-w-0 flex-[45] flex-col overflow-hidden">
        <ContextBar />
        {activeWorkspace ? (
          <SessionStoreContext.Provider
            value={getOrCreateWorkspaceStore(activeWorkspace)}
          >
            <div className="min-h-0 flex-1 overflow-hidden">
              <ChatPanel />
            </div>
          </SessionStoreContext.Provider>
        ) : (
          <div className="flex flex-1 items-center justify-center">
            <span className="text-sm text-muted-foreground">워크스페이스를 선택하세요</span>
          </div>
        )}
      </div>
    </div>
  )
}
