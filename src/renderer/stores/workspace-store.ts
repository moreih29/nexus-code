import log from 'electron-log/renderer'
import { create } from 'zustand'

const rlog = log.scope('renderer:workspace-store')
import { IpcChannel } from '../../shared/ipc'
import type {
  WorkspaceEntry,
  WorkspaceListResponse,
  WorkspaceAddResponse,
  WorkspaceRemoveResponse,
  WorkspaceUpdateSessionResponse,
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
  saveSessionId: (path: string, sessionId: string) => Promise<void>
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  workspaces: [],
  activeWorkspace: null,
  loading: false,

  loadWorkspaces: async () => {
    set({ loading: true })
    try {
      const res = await window.electronAPI.invoke(IpcChannel.WORKSPACE_LIST)
      set({ workspaces: res.workspaces })
    } catch (err) {
      rlog.error('WORKSPACE_LIST error:', err)
    } finally {
      set({ loading: false })
    }
  },

  addWorkspace: async () => {
    const res = await window.electronAPI.invoke(IpcChannel.WORKSPACE_ADD)
    if (!res.cancelled && res.workspace) {
      const { workspaces } = get()
      if (!workspaces.some((w) => w.path === res.workspace!.path)) {
        set({ workspaces: [...workspaces, res.workspace] })
      }
      set({ activeWorkspace: res.workspace.path })
    }
  },

  removeWorkspace: async (path: string) => {
    await window.electronAPI.invoke(IpcChannel.WORKSPACE_REMOVE, { path })
    set((s) => ({
      workspaces: s.workspaces.filter((w) => w.path !== path),
      activeWorkspace: s.activeWorkspace === path ? null : s.activeWorkspace,
    }))
  },

  setActiveWorkspace: (path) => set({ activeWorkspace: path }),

  saveSessionId: async (path, sessionId) => {
    set((s) => ({
      workspaces: s.workspaces.map((w) => w.path === path ? { ...w, sessionId } : w),
    }))
    try {
      await window.electronAPI.invoke(
        IpcChannel.WORKSPACE_UPDATE_SESSION,
        { path, sessionId }
      )
    } catch (err) {
      rlog.error('WORKSPACE_UPDATE_SESSION error:', err)
    }
  },
}))
