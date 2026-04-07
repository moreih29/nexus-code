import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { SessionEvent } from '@nexus/shared'
import {
  createInitialState,
  applyEvent,
  addUserMessage,
  type SessionState,
} from '../adapters/session-adapter.js'

type ActiveTab = 'main' | string // 'main' or subagent id

// Unified subagent shape for live data
export type UnifiedSubagent = {
  id: string
  name: string
  type: string
  status: 'running' | 'done' | 'waiting_permission'
  summary: string
  durationSec?: number
}

interface ChatState {
  // Live session state (adapter output)
  sessionState: SessionState
  sessionId: string | null
  isConnected: boolean
  activeTab: ActiveTab

  // Actions
  applyServerEvent: (event: SessionEvent) => void
  sendMessage: (text: string) => void
  setSessionId: (id: string) => void
  setConnected: (connected: boolean) => void
  setActiveTab: (tab: ActiveTab) => void
  resetSession: () => void

  // Selectors
  getSubagents: () => UnifiedSubagent[]
  getActiveSubagent: () => UnifiedSubagent | null
  getActiveMessages: () => SessionState['messages']
}

export const useChatStore = create<ChatState>()(
  persist(
    (set, get) => ({
      sessionState: createInitialState(),
      sessionId: null,
      isConnected: false,
      activeTab: 'main',

      applyServerEvent: (event) => {
        set((state) => ({
          sessionState: applyEvent(state.sessionState, event),
          sessionId: state.sessionId ?? event.sessionId,
        }))
      },

      sendMessage: (text) => {
        set((state) => ({
          sessionState: addUserMessage(state.sessionState, text),
        }))
      },

      setSessionId: (id) => set({ sessionId: id }),

      setConnected: (connected) => set({ isConnected: connected }),

      setActiveTab: (tab) => set({ activeTab: tab }),

      resetSession: () =>
        set({
          sessionState: createInitialState(),
          sessionId: null,
          isConnected: false,
          activeTab: 'main',
        }),

      getSubagents: () => {
        const { sessionState } = get()
        return sessionState.subagents.map((sa) => ({
          id: sa.id,
          name: sa.name,
          type: sa.type,
          status: sa.status,
          summary: sa.summary,
          durationSec: sa.durationSec,
        }))
      },

      getActiveSubagent: () => {
        const { activeTab } = get()
        if (activeTab === 'main') return null
        const subagents = get().getSubagents()
        return subagents.find((sa) => sa.id === activeTab) ?? null
      },

      getActiveMessages: () => {
        const { sessionState } = get()
        return sessionState.messages
      },
    }),
    {
      name: 'nexus-chat',
      partialize: (state) => ({
        sessionId: state.sessionId,
        sessionState: {
          ...state.sessionState,
          // Map → plain object for JSON serialization
          pendingToolCalls: Object.fromEntries(state.sessionState.pendingToolCalls),
        },
      }),
      merge: (persisted, current): ChatState => {
        const p = persisted as Record<string, unknown> | undefined
        if (!p?.sessionId) return current
        const savedState = p.sessionState as Record<string, unknown> | undefined
        return {
          ...current,
          sessionId: p.sessionId as string,
          sessionState: savedState
            ? {
                ...current.sessionState,
                ...(savedState as object),
                pendingToolCalls: new Map(
                  Object.entries(
                    (savedState.pendingToolCalls ?? {}) as Record<string, import('../adapters/session-adapter.js').ToolCallState>,
                  ),
                ),
              }
            : current.sessionState,
        }
      },
    },
  ),
)
