import { create } from 'zustand'
import type { SessionEvent } from '@nexus/shared'
import {
  createInitialState,
  applyEvent,
  addUserMessage,
  type SessionState,
} from '../adapters/session-adapter.js'
import {
  mockMessages,
  mockSubagents,
  mockSubagentLog,
  mockEngineerLog,
  type MockSubagent,
  type MockMessage,
} from '../mock/data.js'

type ActiveTab = 'main' | string // 'main' or subagent id

interface ChatState {
  // Live session state (adapter output)
  sessionState: SessionState
  sessionId: string | null
  isConnected: boolean
  activeTab: ActiveTab

  // Mock fallback
  useMock: boolean
  mockSubagents: MockSubagent[]
  mockSubagentLogs: Record<string, MockMessage[]>

  // Actions
  applyServerEvent: (event: SessionEvent) => void
  sendMessage: (text: string) => void
  setSessionId: (id: string) => void
  setConnected: (connected: boolean) => void
  setUseMock: (useMock: boolean) => void
  setActiveTab: (tab: ActiveTab) => void

  // Selectors
  getActiveSubagent: () => MockSubagent | null
  getActiveMessages: () => MockMessage[] | SessionState['messages']
}

export const useChatStore = create<ChatState>((set, get) => ({
  sessionState: createInitialState(),
  sessionId: null,
  isConnected: false,
  activeTab: 'main',

  useMock: true,
  mockSubagents: mockSubagents,
  mockSubagentLogs: {
    'sa-2': mockSubagentLog,
    'sa-3': mockEngineerLog,
  },

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

  setUseMock: (useMock) => set({ useMock }),

  setActiveTab: (tab) => set({ activeTab: tab }),

  getActiveSubagent: () => {
    const { mockSubagents: subagents, activeTab } = get()
    if (activeTab === 'main') return null
    return subagents.find((sa) => sa.id === activeTab) ?? null
  },

  getActiveMessages: () => {
    const { sessionState, useMock, mockSubagentLogs, activeTab } = get()
    if (activeTab !== 'main') {
      return mockSubagentLogs[activeTab] ?? []
    }
    if (useMock && sessionState.messages.length === 0) {
      return mockMessages
    }
    return sessionState.messages
  },
}))
