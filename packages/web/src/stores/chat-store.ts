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
  restorableSessionId: string | null // DB 세션 ID (resume용)
  isConnected: boolean
  activeTab: ActiveTab
  isLoadingHistory: boolean
  isWaitingResponse: boolean

  // Actions
  applyServerEvent: (event: SessionEvent) => void
  sendMessage: (text: string) => void
  setSessionId: (id: string) => void
  setConnected: (connected: boolean) => void
  setActiveTab: (tab: ActiveTab) => void
  resetSession: () => void
  restoreFromHistory: (restorableId: string, messages: ChatMessage[]) => void

  // Selectors
  getSubagents: () => UnifiedSubagent[]
  getActiveSubagent: () => UnifiedSubagent | null
  getActiveMessages: () => SessionState['messages']
}

export const useChatStore = create<ChatState>((set, get) => ({
  sessionState: createInitialState(),
  sessionId: null,
  restorableSessionId: null,
  isConnected: false,
  activeTab: 'main',
  isLoadingHistory: false,
  isWaitingResponse: false,

  applyServerEvent: (event) => {
    set((state) => {
      const nextSessionState = applyEvent(state.sessionState, event)
      console.log('[chat-store] applyServerEvent', event.type, 'messages.len',
        state.sessionState.messages.length, '→', nextSessionState.messages.length)
      return {
        sessionState: nextSessionState,
        sessionId: state.sessionId ?? event.sessionId,
        isWaitingResponse: false,
      }
    })
  },

  sendMessage: (text) => {
    set((state) => ({
      sessionState: addUserMessage(state.sessionState, text),
      isWaitingResponse: true,
    }))
  },

  setSessionId: (id) => set({ sessionId: id }),

  setConnected: (connected) => set({ isConnected: connected }),

  setActiveTab: (tab) => set({ activeTab: tab }),

  resetSession: () =>
    set({
      sessionState: createInitialState(),
      sessionId: null,
      restorableSessionId: null,
      isConnected: false,
      activeTab: 'main',
      isLoadingHistory: false,
      isWaitingResponse: false,
    }),

  restoreFromHistory: (restorableId, messages) => {
    set({
      sessionId: null,
      restorableSessionId: restorableId || null,
      sessionState: {
        ...createInitialState(),
        messages,
      },
      isLoadingHistory: false,
      isWaitingResponse: false,
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
