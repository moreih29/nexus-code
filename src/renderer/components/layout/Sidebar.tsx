import { memo, useState } from 'react'
import { PanelLeft, Settings } from 'lucide-react'
import { WorkspaceList } from '../workspace/WorkspaceList'
import { SettingsModal } from '../settings/SettingsModal'

interface SidebarProps {
  onToggle?: () => void
  isCollapsed?: boolean
}

export const Sidebar = memo(function Sidebar({ onToggle, isCollapsed }: SidebarProps) {
  const [settingsOpen, setSettingsOpen] = useState(false)

  return (
    <>
      {/* 접힌 상태: 아이콘 스트립 */}
      {isCollapsed && (
        <aside className="flex h-full w-full flex-col items-center border-r border-border bg-card py-2">
          <button
            onClick={onToggle}
            className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            title="사이드바 열기"
          >
            <PanelLeft size={18} />
          </button>
          <div className="flex-1" />
          <button
            onClick={() => setSettingsOpen(true)}
            className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            title="설정"
          >
            <Settings size={18} />
          </button>
        </aside>
      )}

      {/* 펼친 상태: WorkspaceList는 항상 마운트, display로 숨김 */}
      <aside className="flex h-full flex-col border-r border-border bg-card" style={{ display: isCollapsed ? 'none' : undefined }}>
        <div className="flex h-12 items-center justify-between border-b border-border px-4">
          <span className="text-sm font-semibold text-foreground">Workspaces</span>
          <button
            onClick={() => setSettingsOpen(true)}
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            title="Settings"
          >
            <Settings size={16} />
          </button>
        </div>
        <div className="min-h-0 flex-1">
          <WorkspaceList />
        </div>
      </aside>

      <SettingsModal isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </>
  )
})
