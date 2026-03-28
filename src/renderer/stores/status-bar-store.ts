import { create } from 'zustand'

export interface TodoItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

export interface AskQuestion {
  toolUseId: string
  question: string
  options: string[]
}

interface StatusBarState {
  todos: TodoItem[]
  askQuestion: AskQuestion | null

  // Actions
  setTodos: (todos: TodoItem[]) => void
  setAskQuestion: (askQuestion: AskQuestion | null) => void
  clearAll: () => void
}

export const useStatusBarStore = create<StatusBarState>((set) => ({
  todos: [],
  askQuestion: null,

  setTodos: (todos) => set({ todos }),

  setAskQuestion: (askQuestion) => set({ askQuestion }),

  clearAll: () => set({ todos: [], askQuestion: null }),
}))
