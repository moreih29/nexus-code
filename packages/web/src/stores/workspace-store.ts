import { create } from 'zustand'

interface WorkspaceState {
  activeWorkspaceId: string | null
  setActiveWorkspace: (id: string) => void
  setActiveByIndex: (index: number, workspaceIds: string[]) => void
}

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  activeWorkspaceId: null,

  setActiveWorkspace: (id) => set({ activeWorkspaceId: id }),

  setActiveByIndex: (index, workspaceIds) => {
    if (index >= 0 && index < workspaceIds.length) {
      set({ activeWorkspaceId: workspaceIds[index] })
    }
  },
}))
