import { create } from 'zustand'
import { apiClient } from '@/api/client'

export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions'
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

export function normalizeModelId(value: unknown): ModelId {
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

  // Internal: tracks keys with in-flight quickSave requests
  _pendingSaveKeys: Set<string>

  // Actions
  loadSettings: (workspacePath: string | null) => Promise<void>
  updateDraft: (scope: SettingsScope, partial: Partial<AppSettings>) => void
  updateDraftCli: (scope: SettingsScope, partial: Partial<CliSettings>) => void
  resetProjectKey: (key: keyof AppSettings) => void
  saveSettings: (workspacePath: string | null) => Promise<void>
  /** Save a single setting immediately to server (used by status bar quick changes) */
  quickSave: (partial: Partial<AppSettings>, workspacePath: string | null) => Promise<void>
}

type SettingsState = DrawerSettingsState

export const useSettingsStore = create<SettingsState>()((set, get) => ({
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
  _pendingSaveKeys: new Set<string>(),

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

      // Protect keys with in-flight quickSave requests from being overwritten
      const { _pendingSaveKeys, globalSettings: currentGlobal, projectSettings: currentProject } = get()
      if (_pendingSaveKeys.size > 0) {
        for (const key of _pendingSaveKeys) {
          if (key in currentGlobal) (globalSettings as Record<string, unknown>)[key] = currentGlobal[key as keyof AppSettings]
          if (key in currentProject) (projectSettings as Record<string, unknown>)[key] = currentProject[key as keyof AppSettings]
        }
      }

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
    } catch (err) {
      console.error('[settings] saveSettings failed', err)
      throw err
    }
  },

  quickSave: async (partial, workspacePath) => {
    const keys = Object.keys(partial)

    // Save previous values for rollback on failure
    const current = workspacePath ? get().projectSettings : get().globalSettings
    const prevValues: Partial<AppSettings> = {}
    for (const k of keys) (prevValues as Record<string, unknown>)[k] = current[k as keyof AppSettings]

    // Register keys as pending before the API call
    set((s) => ({ _pendingSaveKeys: new Set([...s._pendingSaveKeys, ...keys]) }))

    try {
      if (workspacePath) {
        const encoded = encodeURIComponent(workspacePath)
        // Optimistic update
        set((s) => ({
          projectSettings: { ...s.projectSettings, ...partial },
          draftProject: { ...s.draftProject, ...partial },
        }))
        // Server merges and returns the full merged result
        const merged = await apiClient.put<AppSettings>(`/api/settings?scope=project&workspace=${encoded}`, partial)
        // Confirm with authoritative server response
        set((s) => ({
          projectSettings: merged,
          draftProject: { ...s.draftProject, ...merged },
        }))
      } else {
        // Optimistic update
        set((s) => ({
          globalSettings: { ...s.globalSettings, ...partial },
          draftGlobal: { ...s.draftGlobal, ...partial },
        }))
        // Server merges and returns the full merged result
        const merged = await apiClient.put<AppSettings>('/api/settings?scope=global', partial)
        // Confirm with authoritative server response
        set((s) => ({
          globalSettings: merged,
          draftGlobal: { ...s.draftGlobal, ...merged },
        }))
      }
    } catch (err) {
      // Rollback optimistic update to previous values
      if (workspacePath) {
        set((s) => ({
          projectSettings: { ...s.projectSettings, ...prevValues },
          draftProject: { ...s.draftProject, ...prevValues },
        }))
      } else {
        set((s) => ({
          globalSettings: { ...s.globalSettings, ...prevValues },
          draftGlobal: { ...s.draftGlobal, ...prevValues },
        }))
      }
      console.error('[settings] quickSave failed', err)
    } finally {
      // Always remove pending keys after the request settles
      set((s) => {
        const next = new Set(s._pendingSaveKeys)
        keys.forEach((k) => next.delete(k))
        return { _pendingSaveKeys: next }
      })
    }
  },
}))

/** Effective model from merged global+project settings */
export function useEffectiveModel(): ModelId {
  return useSettingsStore((s) => normalizeModelId({ ...s.globalSettings, ...s.projectSettings }.model))
}

export function useEffectivePermissionMode(): PermissionMode {
  return useSettingsStore((s) => {
    const mode = { ...s.globalSettings, ...s.projectSettings }.permissionMode
    if (mode === 'auto') return 'bypassPermissions'
    return (mode as PermissionMode) ?? 'default'
  })
}

/** For non-React contexts (e.g., chat-input onSubmit) */
export function getEffectiveSettings() {
  const { globalSettings, projectSettings } = useSettingsStore.getState()
  return { ...globalSettings, ...projectSettings }
}
