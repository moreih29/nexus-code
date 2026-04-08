import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { apiClient } from '@/api/client'

export type PermissionMode = 'default' | 'auto' | 'bypassPermissions'
export type EffortLevel = 'low' | 'medium' | 'high' | 'max'

export const MODELS = [
  { id: 'opus', label: 'Opus' },
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'haiku', label: 'Haiku' },
] as const

export type ModelId = (typeof MODELS)[number]['id']

// Normalize legacy full model names to aliases for backward compat with persisted state
const LEGACY_MODEL_MAP: Record<string, ModelId> = {
  'claude-opus-4-5': 'opus',
  'claude-sonnet-4-5': 'sonnet',
  'claude-haiku-4-5': 'haiku',
  'claude-opus-4-6': 'opus',
  'claude-sonnet-4-6': 'sonnet',
  'claude-haiku-4-6': 'haiku',
}

function normalizeModelId(value: unknown): ModelId {
  if (typeof value === 'string') {
    if (LEGACY_MODEL_MAP[value]) return LEGACY_MODEL_MAP[value]
    if (MODELS.some((m) => m.id === value)) return value as ModelId
  }
  return 'sonnet'
}

// Tier 1: App-internal settings (DB-backed)
export interface AppSettings {
  model?: string
  effortLevel?: string
  permissionMode?: string
  maxTurns?: number
  maxBudgetUsd?: number
  appendSystemPrompt?: string
  addDirs?: string[]
  disallowedTools?: string[]
  chromeEnabled?: boolean
  theme?: string
}

// Tier 2: CLI settings.json
export interface CliSettings {
  permissions?: {
    allow?: string[]
    deny?: string[]
  }
  language?: string
  alwaysThinkingEnabled?: boolean
}

export type SettingsScope = 'global' | 'project'

interface DrawerSettingsState {
  // Modal open state
  modalOpen: boolean
  setModalOpen: (open: boolean) => void

  // Current scope
  scope: SettingsScope
  setScope: (scope: SettingsScope) => void

  // Loaded settings from server
  globalSettings: AppSettings
  projectSettings: AppSettings
  globalCliSettings: CliSettings
  projectCliSettings: CliSettings

  // Draft (unsaved) edits — keyed by scope
  draftGlobal: AppSettings
  draftProject: AppSettings
  draftGlobalCli: CliSettings
  draftProjectCli: CliSettings

  // Dirty tracking
  isDirtyGlobal: boolean
  isDirtyProject: boolean

  // Loading state
  isLoading: boolean

  // Actions
  loadSettings: (workspacePath: string | null) => Promise<void>
  updateDraft: (scope: SettingsScope, partial: Partial<AppSettings>) => void
  updateDraftCli: (scope: SettingsScope, partial: Partial<CliSettings>) => void
  resetProjectKey: (key: keyof AppSettings) => void
  saveSettings: (workspacePath: string | null) => Promise<void>
  /** Save a single setting immediately to server (used by status bar quick changes) */
  quickSave: (partial: Partial<AppSettings>, workspacePath: string | null) => Promise<void>
}

// Legacy state kept for status bar backward compat
interface LegacySettingsState {
  defaultModel: ModelId
  defaultPermissionMode: PermissionMode
  defaultEffortLevel: EffortLevel
  defaultMaxTurns: number | null

  setDefaultModel: (model: ModelId) => void
  setDefaultPermissionMode: (mode: PermissionMode) => void
  setDefaultEffortLevel: (level: EffortLevel) => void
  setDefaultMaxTurns: (turns: number | null) => void
}

type SettingsState = LegacySettingsState & DrawerSettingsState

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set, get) => ({
      // Legacy
      defaultModel: 'sonnet',
      defaultPermissionMode: 'default',
      defaultEffortLevel: 'high',
      defaultMaxTurns: null,

      setDefaultModel: (model) => set({ defaultModel: model }),
      setDefaultPermissionMode: (mode) => set({ defaultPermissionMode: mode }),
      setDefaultEffortLevel: (level) => set({ defaultEffortLevel: level }),
      setDefaultMaxTurns: (turns) => set({ defaultMaxTurns: turns }),

      // Modal
      modalOpen: false,
      setModalOpen: (open) => set({ modalOpen: open }),

      scope: 'global',
      setScope: (scope) => set({ scope }),

      globalSettings: {},
      projectSettings: {},
      globalCliSettings: {},
      projectCliSettings: {},

      draftGlobal: {},
      draftProject: {},
      draftGlobalCli: {},
      draftProjectCli: {},

      isDirtyGlobal: false,
      isDirtyProject: false,
      isLoading: false,

      loadSettings: async (workspacePath) => {
        set({ isLoading: true })
        try {
          const [globalSettings, globalCliSettings] = await Promise.all([
            apiClient.get<AppSettings>('/api/settings?scope=global'),
            apiClient.get<CliSettings>('/api/cli-settings?scope=global'),
          ])

          let projectSettings: AppSettings = {}
          let projectCliSettings: CliSettings = {}

          if (workspacePath) {
            const encoded = encodeURIComponent(workspacePath)
            ;[projectSettings, projectCliSettings] = await Promise.all([
              apiClient.get<AppSettings>(`/api/settings?scope=project&workspace=${encoded}`),
              apiClient.get<CliSettings>(`/api/cli-settings?scope=project&workspace=${encoded}`),
            ])
          }

          // Compute effective settings for status bar sync
          const effective = { ...globalSettings, ...projectSettings }

          set({
            globalSettings,
            projectSettings,
            globalCliSettings,
            projectCliSettings,
            draftGlobal: { ...globalSettings },
            draftProject: { ...projectSettings },
            draftGlobalCli: { ...globalCliSettings },
            draftProjectCli: { ...projectCliSettings },
            isDirtyGlobal: false,
            isDirtyProject: false,
            isLoading: false,
            // Sync legacy state for status bar
            defaultModel: normalizeModelId(effective.model),
            defaultPermissionMode: (effective.permissionMode as PermissionMode) ?? 'default',
            defaultEffortLevel: (effective.effortLevel as EffortLevel) ?? 'medium',
          })
        } catch (err) {
          console.error('[settings] loadSettings failed', err)
          set({ isLoading: false })
        }
      },

      updateDraft: (scope, partial) => {
        if (scope === 'global') {
          set((s) => ({
            draftGlobal: { ...s.draftGlobal, ...partial },
            isDirtyGlobal: true,
          }))
        } else {
          set((s) => ({
            draftProject: { ...s.draftProject, ...partial },
            isDirtyProject: true,
          }))
        }
      },

      updateDraftCli: (scope, partial) => {
        if (scope === 'global') {
          set((s) => ({
            draftGlobalCli: { ...s.draftGlobalCli, ...partial },
            isDirtyGlobal: true,
          }))
        } else {
          set((s) => ({
            draftProjectCli: { ...s.draftProjectCli, ...partial },
            isDirtyProject: true,
          }))
        }
      },

      resetProjectKey: (key) => {
        set((s) => {
          const next = { ...s.draftProject }
          delete next[key]
          return { draftProject: next, isDirtyProject: true }
        })
      },

      saveSettings: async (workspacePath) => {
        const {
          scope,
          draftGlobal,
          draftProject,
          draftGlobalCli,
          draftProjectCli,
          isDirtyGlobal,
          isDirtyProject,
        } = get()

        try {
          if (scope === 'global' && isDirtyGlobal) {
            await Promise.all([
              apiClient.put<AppSettings>('/api/settings?scope=global', draftGlobal),
              apiClient.put<CliSettings>('/api/cli-settings?scope=global', draftGlobalCli),
            ])
            set({ globalSettings: { ...draftGlobal }, globalCliSettings: { ...draftGlobalCli }, isDirtyGlobal: false })
          }

          if (scope === 'project' && isDirtyProject && workspacePath) {
            const encoded = encodeURIComponent(workspacePath)
            await Promise.all([
              apiClient.put<AppSettings>(`/api/settings?scope=project&workspace=${encoded}`, draftProject),
              apiClient.put<CliSettings>(`/api/cli-settings?scope=project&workspace=${encoded}`, draftProjectCli),
            ])
            set({ projectSettings: { ...draftProject }, projectCliSettings: { ...draftProjectCli }, isDirtyProject: false })
          }

          // Sync legacy state for status bar after save
          const { globalSettings: gs, projectSettings: ps } = get()
          const effective = { ...gs, ...ps }
          set({
            defaultModel: normalizeModelId(effective.model),
            defaultPermissionMode: (effective.permissionMode as PermissionMode) ?? 'default',
            defaultEffortLevel: (effective.effortLevel as EffortLevel) ?? 'medium',
          })
        } catch (err) {
          console.error('[settings] saveSettings failed', err)
          throw err
        }
      },

      quickSave: async (partial, workspacePath) => {
        try {
          if (workspacePath) {
            const encoded = encodeURIComponent(workspacePath)
            set((s) => ({
              projectSettings: { ...s.projectSettings, ...partial },
              draftProject: { ...s.draftProject, ...partial },
            }))
            // Send only the partial — server merges with existing
            await apiClient.put<AppSettings>(`/api/settings?scope=project&workspace=${encoded}`, partial)
          } else {
            set((s) => ({
              globalSettings: { ...s.globalSettings, ...partial },
              draftGlobal: { ...s.draftGlobal, ...partial },
            }))
            // Send only the partial — server merges with existing
            await apiClient.put<AppSettings>('/api/settings?scope=global', partial)
          }

          // Sync legacy state for status bar after quickSave
          const { globalSettings: gs, projectSettings: ps } = get()
          const effective = { ...gs, ...ps }
          set({
            defaultModel: normalizeModelId(effective.model),
            defaultPermissionMode: (effective.permissionMode as PermissionMode) ?? 'default',
            defaultEffortLevel: (effective.effortLevel as EffortLevel) ?? 'medium',
          })
        } catch (err) {
          console.error('[settings] quickSave failed', err)
        }
      },
    }),
    {
      name: 'nexus-settings',
      // Only persist legacy UI state — server-fetched settings are not persisted
      partialize: (state) => ({
        defaultModel: state.defaultModel,
        defaultPermissionMode: state.defaultPermissionMode,
        defaultEffortLevel: state.defaultEffortLevel,
        defaultMaxTurns: state.defaultMaxTurns,
      }),
      merge: (persisted, current) => {
        const p = persisted as Partial<LegacySettingsState>
        return {
          ...current,
          ...p,
          defaultModel: normalizeModelId(p.defaultModel),
        }
      },
    }
  )
)
