import { create } from 'zustand'
import { mockWorkspaces, type MockWorkspace } from '../mock/data.js'

interface WorkspaceState {
  workspaces: MockWorkspace[]
  activeWorkspaceId: string | null
  getActiveWorkspace: () => MockWorkspace | null
  setActiveWorkspace: (id: string) => void
  setActiveByIndex: (index: number) => void
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  workspaces: mockWorkspaces,
  activeWorkspaceId: mockWorkspaces[0]?.id ?? null,

  getActiveWorkspace: () => {
    const { workspaces, activeWorkspaceId } = get()
    return workspaces.find((ws) => ws.id === activeWorkspaceId) ?? null
  },

  setActiveWorkspace: (id) => set({ activeWorkspaceId: id }),

  setActiveByIndex: (index) => {
    const { workspaces } = get()
    if (index >= 0 && index < workspaces.length) {
      set({ activeWorkspaceId: workspaces[index].id })
    }
  },
}))
