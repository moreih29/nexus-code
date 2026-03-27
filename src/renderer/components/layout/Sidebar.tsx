import { useState } from 'react'
import { Settings } from 'lucide-react'
import { WorkspaceList } from '../workspace/WorkspaceList'
import { SettingsModal } from '../settings/SettingsModal'

export function Sidebar(): JSX.Element {
  const [settingsOpen, setSettingsOpen] = useState(false)

  return (
    <>
      <aside className="flex h-full w-[250px] shrink-0 flex-col border-r border-gray-800 bg-gray-900">
        <div className="flex h-12 items-center justify-between border-b border-gray-800 px-4">
          <span className="text-sm font-semibold text-gray-300">Workspaces</span>
          <button
            onClick={() => setSettingsOpen(true)}
            className="rounded p-1 text-gray-500 hover:bg-gray-800 hover:text-gray-300"
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
