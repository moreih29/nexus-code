import { useState } from 'react'
import { Settings } from 'lucide-react'
import { WorkspaceList } from '../workspace/WorkspaceList'
import { SettingsModal } from '../settings/SettingsModal'

export function Sidebar() {
  const [settingsOpen, setSettingsOpen] = useState(false)

  return (
    <>
      <aside className="flex h-full w-[250px] shrink-0 flex-col border-r border-border bg-card">
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
