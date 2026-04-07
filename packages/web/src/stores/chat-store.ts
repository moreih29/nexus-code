import { create } from 'zustand'
import type { SessionEvent } from '@nexus/shared'
import {
  createInitialState,
  applyEvent,
  addUserMessage,
  type SessionState,
  type ChatMessage,
} from '../adapters/session-adapter.js'

type ActiveTab = 'main' | string // 'main' or subagent id

export type UnifiedSubagent = {
  id: string
  name: string
  type: string
  status: 'running' | 'done' | 'waiting_permission'
  summary: string
  durationSec?: number
}

interface ChatState {
  sessionState: SessionState
  sessionId: string | null
  isConnected: boolean
  activeTab: ActiveTab
  isLoadingHistory: boolean

  // Actions
  applyServerEvent: (event: SessionEvent) => void
  sendMessage: (text: string) => void
  setSessionId: (id: string) => void
  setConnected: (connected: boolean) => void
  setActiveTab: (tab: ActiveTab) => void
  resetSession: () => void
  restoreFromHistory: (sessionId: string, messages: ChatMessage[]) => void

  // Selectors
  getSubagents: () => UnifiedSubagent[]
  getActiveSubagent: () => UnifiedSubagent | null
  getActiveMessages: () => SessionState['messages']
}

export const useChatStore = create<ChatState>((set, get) => ({
  sessionState: createInitialState(),
  sessionId: null,
  isConnected: false,
  activeTab: 'main',
  isLoadingHistory: false,

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
      isLoadingHistory: false,
    }),

  restoreFromHistory: (sessionId, messages) => {
    set({
      sessionId: sessionId || null,
      sessionState: {
        ...createInitialState(),
        sessionId: sessionId || null,
        messages,
      },
      isLoadingHistory: false,
    })
  },

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
}))
