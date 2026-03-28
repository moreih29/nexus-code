import { create } from 'zustand'

export interface FileChange {
  filePath: string
  toolName: string
  toolUseId: string
  timestamp: number
  oldString?: string
  newString?: string
  content?: string
}

interface ChangesState {
  changes: FileChange[]
  trackChange: (change: FileChange) => void
  clear: () => void
}

export const useChangesStore = create<ChangesState>((set) => ({
  changes: [],

  trackChange: (change) =>
    set((s) => ({ changes: [...s.changes, change] })),

  clear: () => set({ changes: [] }),
}))
