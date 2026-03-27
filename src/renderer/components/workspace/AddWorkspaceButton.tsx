import { FolderPlus } from 'lucide-react'
import { useWorkspaceStore } from '../../stores/workspace-store'

export function AddWorkspaceButton() {
  const addWorkspace = useWorkspaceStore((s) => s.addWorkspace)

  const handleClick = async (): Promise<void> => {
    await addWorkspace()
  }

  return (
    <button
      onClick={handleClick}
      className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-gray-500 transition-colors hover:bg-gray-800 hover:text-gray-300"
    >
      <FolderPlus size={14} />
      <span>폴더 추가</span>
    </button>
  )
}
