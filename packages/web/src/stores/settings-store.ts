import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type PermissionMode = 'default' | 'auto' | 'bypassPermissions'
export type EffortLevel = 'low' | 'medium' | 'high'

export const MODELS = [
  { id: 'claude-opus-4-5', label: 'Opus 4' },
  { id: 'claude-sonnet-4-5', label: 'Sonnet 4' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4' },
] as const

export type ModelId = (typeof MODELS)[number]['id']

interface SettingsState {
  defaultModel: ModelId
  defaultPermissionMode: PermissionMode
  defaultEffortLevel: EffortLevel
  defaultMaxTurns: number | null

  setDefaultModel: (model: ModelId) => void
  setDefaultPermissionMode: (mode: PermissionMode) => void
  setDefaultEffortLevel: (level: EffortLevel) => void
  setDefaultMaxTurns: (turns: number | null) => void
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      defaultModel: 'claude-sonnet-4-5',
      defaultPermissionMode: 'default',
      defaultEffortLevel: 'high',
      defaultMaxTurns: null,

      setDefaultModel: (model) => set({ defaultModel: model }),
      setDefaultPermissionMode: (mode) => set({ defaultPermissionMode: mode }),
      setDefaultEffortLevel: (level) => set({ defaultEffortLevel: level }),
      setDefaultMaxTurns: (turns) => set({ defaultMaxTurns: turns }),
    }),
    {
      name: 'nexus-settings',
    }
  )
)
