import { create } from 'zustand'
import type { SessionEvent } from '@nexus/shared'
import {
  createInitialState,
  applyEvent,
  addUserMessage,
  type SessionState,
  type SubagentState,
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

// Unified subagent shape that works for both mock and live data
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
  resetSession: () => void

  // Selectors
  getSubagents: () => UnifiedSubagent[]
  getActiveSubagent: () => UnifiedSubagent | null
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

  resetSession: () =>
    set({
      sessionState: createInitialState(),
      sessionId: null,
      isConnected: false,
      activeTab: 'main',
      useMock: true,
    }),

  getSubagents: () => {
    const { sessionState, useMock, mockSubagents: mocks } = get()
    if (useMock && sessionState.subagents.length === 0) {
      return mocks.map((m) => ({
        id: m.id,
        name: m.name,
        type: m.type,
        status: m.status as UnifiedSubagent['status'],
        summary: m.summary,
      }))
    }
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
