import { create } from 'zustand'

interface ContextBinding {
  selectedAgentIds: string[] | null
  turnRange: { from: number; to: number } | null
  filterMode: 'all' | 'agent' | 'turn'
}

interface ContextStoreState {
  binding: ContextBinding
  selectAgents: (agentIds: string[] | null) => void
  selectTurnRange: (range: { from: number; to: number } | null) => void
  setFilterMode: (mode: ContextBinding['filterMode']) => void
  reset: () => void
}

const defaultBinding: ContextBinding = {
  selectedAgentIds: null,
  turnRange: null,
  filterMode: 'all',
}

export const useContextStore = create<ContextStoreState>((set) => ({
  binding: { ...defaultBinding },

  selectAgents: (agentIds) =>
    set((s) => ({ binding: { ...s.binding, selectedAgentIds: agentIds } })),

  selectTurnRange: (range) =>
    set((s) => ({ binding: { ...s.binding, turnRange: range } })),

  setFilterMode: (mode) =>
    set((s) => ({ binding: { ...s.binding, filterMode: mode } })),

  reset: () => set({ binding: { ...defaultBinding } }),
}))
