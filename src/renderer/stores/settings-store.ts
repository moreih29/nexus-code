import { create } from 'zustand'

export const AVAILABLE_MODELS = [
  'claude-opus-4-6',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
] as const

export type ModelId = (typeof AVAILABLE_MODELS)[number]
export type PermissionMode = 'auto' | 'default'

interface SettingsState {
  model: ModelId
  permissionMode: PermissionMode

  setModel: (model: ModelId) => void
  setPermissionMode: (mode: PermissionMode) => void
}

export const useSettingsStore = create<SettingsState>((set) => ({
  model: 'claude-sonnet-4-6',
  permissionMode: 'default',

  setModel: (model) => set({ model }),
  setPermissionMode: (mode) => set({ permissionMode: mode }),
}))
