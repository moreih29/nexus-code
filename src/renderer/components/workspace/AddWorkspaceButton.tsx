import { FolderPlus } from 'lucide-react'
import { useWorkspaceStore } from '../../stores/workspace-store'
import { getOrCreateWorkspaceStore, setActiveStore } from '../../stores/session-store'
import { useSettingsStore } from '../../stores/settings-store'
import { useRightPanelUIStore } from '../../stores/plugin-store'

export function AddWorkspaceButton() {
  const addWorkspace = useWorkspaceStore((s) => s.addWorkspace)

  const handleClick = async (): Promise<void> => {
    await addWorkspace()
    const { activeWorkspace } = useWorkspaceStore.getState()
    if (activeWorkspace) {
      useRightPanelUIStore.getState().cleanup()
      const store = getOrCreateWorkspaceStore(activeWorkspace)
      setActiveStore(store)
      await useSettingsStore.getState().initialize(activeWorkspace)
    }
  }

  return (
    <button
      onClick={handleClick}
      className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      <FolderPlus size={14} />
      <span>폴더 추가</span>
    </button>
  )
}
