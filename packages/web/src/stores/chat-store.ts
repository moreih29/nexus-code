import { create } from 'zustand'
import {
  mockMessages,
  mockSubagents,
  mockSubagentLog,
  mockEngineerLog,
  type MockMessage,
  type MockSubagent,
} from '../mock/data.js'

type ActiveTab = 'main' | string // 'main' or subagent id

interface ChatState {
  messages: MockMessage[]
  subagents: MockSubagent[]
  activeTab: ActiveTab
  subagentLogs: Record<string, MockMessage[]>

  setActiveTab: (tab: ActiveTab) => void
  getActiveSubagent: () => MockSubagent | null
  getActiveMessages: () => MockMessage[]
}

export const useChatStore = create<ChatState>((set, get) => ({
  messages: mockMessages,
  subagents: mockSubagents,
  activeTab: 'main',
  subagentLogs: {
    'sa-2': mockSubagentLog,
    'sa-3': mockEngineerLog,
  },

  setActiveTab: (tab) => set({ activeTab: tab }),

  getActiveSubagent: () => {
    const { subagents, activeTab } = get()
    if (activeTab === 'main') return null
    return subagents.find((sa) => sa.id === activeTab) ?? null
  },

  getActiveMessages: () => {
    const { messages, subagentLogs, activeTab } = get()
    if (activeTab === 'main') return messages
    return subagentLogs[activeTab] ?? []
  },
}))
