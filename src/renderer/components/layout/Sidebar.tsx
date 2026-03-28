import { useState } from 'react'
import { Settings } from 'lucide-react'
import { WorkspaceList } from '../workspace/WorkspaceList'
import { SettingsModal } from '../settings/SettingsModal'

interface SidebarProps {
  overlay?: boolean
  open?: boolean
  onClose?: () => void
}

export function Sidebar({ overlay = false, open = true, onClose }: SidebarProps) {
  const [settingsOpen, setSettingsOpen] = useState(false)

  if (overlay && !open) {
    return <SettingsModal isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} />
  }

  return (
    <>
      {overlay && (
        <div
          className="sidebar-backdrop"
          onClick={onClose}
          aria-hidden="true"
        />
      )}
      <aside
        className={[
          'flex h-full w-[250px] shrink-0 flex-col border-r border-border bg-card',
          overlay ? 'sidebar-overlay' : '',
        ].join(' ')}
      >
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
