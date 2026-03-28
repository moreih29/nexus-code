import { useState } from 'react'
import { PanelLeft, Settings } from 'lucide-react'
import { WorkspaceList } from '../workspace/WorkspaceList'
import { SettingsModal } from '../settings/SettingsModal'

interface SidebarProps {
  onToggle?: () => void
  isCollapsed?: boolean
}

export function Sidebar({ onToggle, isCollapsed }: SidebarProps) {
  const [settingsOpen, setSettingsOpen] = useState(false)

  if (isCollapsed) {
    return (
      <>
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
        <SettingsModal isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} />
      </>
    )
  }

  return (
    <>
      <aside className="flex h-full flex-col border-r border-border bg-card">
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
}
