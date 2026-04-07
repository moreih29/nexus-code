import { create } from 'zustand'
import { mockWorkspaces, type MockWorkspace } from '../mock/data.js'

interface WorkspaceState {
  workspaces: MockWorkspace[]
  activeWorkspaceId: string | null
  getActiveWorkspace: () => MockWorkspace | null
  setActiveWorkspace: (id: string) => void
  setActiveByIndex: (index: number) => void
  addMockWorkspace: (opts: { path: string; name: string }) => void
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

  addMockWorkspace: ({ path, name }) => {
    const newWs: MockWorkspace = {
      id: `ws-${Date.now()}`,
      name,
      path,
      gitBranch: 'main',
      model: 'sonnet-4',
      status: 'idle',
      activeSubagents: 0,
      totalSubagents: 0,
      pendingApprovals: 0,
    }
    set((state) => ({ workspaces: [...state.workspaces, newWs] }))
  },
}))
