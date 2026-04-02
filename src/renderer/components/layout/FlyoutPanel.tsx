import { useEffect, useRef } from 'react'
import { X, Settings } from 'lucide-react'
import { cn } from '../../lib/utils'
import { WorkspaceList } from '../workspace/WorkspaceList'
import { AgentSidebar } from '../agent/AgentSidebar'
import { useContextStore } from '../../stores/context-store'

export type FlyoutContentType = 'workspace' | 'agents' | 'settings'

interface FlyoutPanelProps {
  isOpen: boolean
  contentType: FlyoutContentType | null
  onClose: () => void
  onOpenSettings?: () => void
  onOpenWorkspaceSettings?: (workspacePath: string) => void
  sessionId?: string | null
}

// ─── 콘텐츠 영역 ─────────────────────────────────────────────────────────────

function WorkspaceContent({ onOpenWorkspaceSettings }: { onOpenWorkspaceSettings?: (workspacePath: string) => void }) {
  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-dim-foreground">탐색기</span>
      </div>
      <div className="min-h-0 flex-1">
        <WorkspaceList onOpenWorkspaceSettings={onOpenWorkspaceSettings} />
      </div>
    </div>
  )
}

function AgentsContent({
  sessionId,
  onAgentSelect,
}: {
  sessionId: string | null
  onAgentSelect: (agentId: string) => void
}) {
  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-dim-foreground">에이전트</span>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <AgentSidebar
          sessionId={sessionId}
          onAgentSelect={onAgentSelect}
        />
      </div>
    </div>
  )
}

function SettingsContent({ onOpenSettings }: { onOpenSettings?: () => void }) {
  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-dim-foreground">설정</span>
      </div>
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-4">
        <p className="text-center text-xs text-dim-foreground">앱 설정을 열어 모델, 외관, 권한 등을 구성하세요.</p>
        <button
          onClick={onOpenSettings}
          className="flex items-center gap-2 rounded-md bg-primary/10 px-3 py-2 text-xs font-medium text-primary hover:bg-primary/20 transition-colors"
        >
          <Settings size={14} />
          설정 열기
        </button>
      </div>
    </div>
  )
}

// ─── FlyoutPanel ─────────────────────────────────────────────────────────────

export function FlyoutPanel({ isOpen, contentType, onClose, onOpenSettings, onOpenWorkspaceSettings, sessionId = null }: FlyoutPanelProps) {
  const selectAgents = useContextStore((s) => s.selectAgents)
  const panelRef = useRef<HTMLDivElement>(null)

  // Esc 키로 닫기 (clickOutside 대신 명시적 닫기만 사용)
  useEffect(() => {
    if (!isOpen) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onClose])

  return (
    <div
      ref={panelRef}
      className={cn(
        'absolute left-11 top-0 z-50 flex h-full w-60 flex-col border-r border-border bg-card shadow-lg',
        'transition-all duration-200 ease-in-out',
        isOpen ? 'translate-x-0 opacity-100' : '-translate-x-full opacity-0 pointer-events-none',
      )}
    >
      {/* 헤더 닫기 버튼 */}
      <button
        onClick={onClose}
        className="absolute right-2 top-2 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
        title="닫기"
      >
        <X size={14} />
      </button>

      {/* 콘텐츠 */}
      <div className="min-h-0 flex-1 overflow-hidden">
        {contentType === 'workspace' && (
          <WorkspaceContent onOpenWorkspaceSettings={onOpenWorkspaceSettings} />
        )}
        {contentType === 'agents' && (
          <AgentsContent
            sessionId={sessionId}
            onAgentSelect={(agentId) => selectAgents([agentId])}
          />
        )}
        {contentType === 'settings' && <SettingsContent onOpenSettings={onOpenSettings} />}
      </div>
    </div>
  )
}
