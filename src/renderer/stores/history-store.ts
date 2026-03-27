import log from 'electron-log/renderer'
import { create } from 'zustand'
import { IpcChannel } from '../../shared/ipc'
import type { SessionInfo, ListSessionsResponse, LoadSessionResponse } from '../../shared/types'

interface HistoryState {
  sessions: SessionInfo[]
  loading: boolean
  activeSessionId: string | null

  // Actions
  loadSessions: () => Promise<void>
  resumeSession: (sessionId: string) => Promise<boolean>
  setActiveSessionId: (sessionId: string | null) => void
}

export const useHistoryStore = create<HistoryState>((set) => ({
  sessions: [],
  loading: false,
  activeSessionId: null,

  loadSessions: async () => {
    set({ loading: true })
    try {
      const res = await window.electronAPI.invoke<ListSessionsResponse>(IpcChannel.LIST_SESSIONS, {})
      set({ sessions: res.sessions })
    } catch (err) {
      log.error('[HistoryStore] LIST_SESSIONS error:', err)
    } finally {
      set({ loading: false })
    }
  },

  resumeSession: async (sessionId: string) => {
    try {
      const res = await window.electronAPI.invoke<LoadSessionResponse>(IpcChannel.LOAD_SESSION, {
        sessionId,
      })
      if (res.ok) {
        set({ activeSessionId: sessionId })
      }
      return res.ok
    } catch (err) {
      log.error('[HistoryStore] LOAD_SESSION error:', err)
      return false
    }
  },

  setActiveSessionId: (sessionId) => set({ activeSessionId: sessionId }),
}))
