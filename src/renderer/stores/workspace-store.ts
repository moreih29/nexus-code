import { create } from 'zustand'
import { IpcChannel } from '../../shared/ipc'
import type {
  WorkspaceEntry,
  WorkspaceListResponse,
  WorkspaceAddResponse,
  WorkspaceRemoveResponse,
} from '../../shared/types'

interface WorkspaceState {
  workspaces: WorkspaceEntry[]
  activeWorkspace: string | null
  loading: boolean

  // Actions
  loadWorkspaces: () => Promise<void>
  addWorkspace: () => Promise<void>
  removeWorkspace: (path: string) => Promise<void>
  setActiveWorkspace: (path: string | null) => void
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  workspaces: [],
  activeWorkspace: null,
  loading: false,

  loadWorkspaces: async () => {
    set({ loading: true })
    try {
      const res = await window.electronAPI.invoke<WorkspaceListResponse>(IpcChannel.WORKSPACE_LIST)
      set({ workspaces: res.workspaces })
    } catch (err) {
      console.error('WORKSPACE_LIST error:', err)
    } finally {
      set({ loading: false })
    }
  },

  addWorkspace: async () => {
    const res = await window.electronAPI.invoke<WorkspaceAddResponse>(IpcChannel.WORKSPACE_ADD)
    if (!res.cancelled && res.workspace) {
      const { workspaces } = get()
      if (!workspaces.some((w) => w.path === res.workspace!.path)) {
        set({ workspaces: [...workspaces, res.workspace] })
      }
    }
  },

  removeWorkspace: async (path: string) => {
    await window.electronAPI.invoke<WorkspaceRemoveResponse>(IpcChannel.WORKSPACE_REMOVE, { path })
    set((s) => ({
      workspaces: s.workspaces.filter((w) => w.path !== path),
      activeWorkspace: s.activeWorkspace === path ? null : s.activeWorkspace,
    }))
  },

  setActiveWorkspace: (path) => set({ activeWorkspace: path }),
}))
