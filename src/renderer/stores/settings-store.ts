import { create } from 'zustand'
import { IpcChannel } from '../../shared/ipc'
import type { ClaudeSettings } from '../../shared/types'
import { AVAILABLE_MODELS, type ModelId } from '../../shared/models'
import { useWorkspaceStore } from './workspace-store'

export { AVAILABLE_MODELS, type ModelId }
export type PermissionMode = 'auto' | 'default'
export type Theme = 'terracotta' | 'github-dark' | 'amethyst' | 'rose-pine' | 'nord' | 'midnight-green'

export const THEMES: { id: Theme; label: string; swatches: [string, string, string] }[] = [
  { id: 'terracotta', label: 'Terracotta', swatches: ['#0d0d0d', '#cc785c', '#1c1a18'] },
  { id: 'github-dark', label: 'GitHub Dark', swatches: ['#0d1117', '#1f6feb', '#161b22'] },
  { id: 'amethyst', label: 'Amethyst', swatches: ['#110d19', '#a855f6', '#1a1624'] },
  { id: 'rose-pine', label: 'Rosé Pine', swatches: ['#191724', '#c4a7e7', '#1f1d2e'] },
  { id: 'nord', label: 'Nord', swatches: ['#1f2430', '#88c0d0', '#232b3a'] },
  { id: 'midnight-green', label: 'Midnight Green', swatches: ['#0e1516', '#2dc57a', '#171f1e'] },
]
export type ToolDensity = 'compact' | 'normal' | 'verbose'

// localStorage 마이그레이션용 키 (읽기 전용 — 마이그레이션 후 삭제)
const STORAGE_KEY_NOTIFICATIONS = 'nexus:notificationsEnabled'
const STORAGE_KEY_THEME = 'nexus:theme'
const STORAGE_KEY_TOOL_DENSITY = 'nexus:toolDensity'

const VALID_THEMES: Theme[] = ['terracotta', 'github-dark', 'amethyst', 'rose-pine', 'nord', 'midnight-green']

function migrateFromLocalStorage(): { theme: Theme; toolDensity: ToolDensity; notificationsEnabled: boolean } {
  let theme: Theme = 'terracotta'
  let toolDensity: ToolDensity = 'compact'
  let notificationsEnabled = true

  try {
    const rawTheme = localStorage.getItem(STORAGE_KEY_THEME)
    if (rawTheme && VALID_THEMES.includes(rawTheme as Theme)) theme = rawTheme as Theme

    const rawDensity = localStorage.getItem(STORAGE_KEY_TOOL_DENSITY)
    if (rawDensity === 'compact' || rawDensity === 'normal' || rawDensity === 'verbose') toolDensity = rawDensity

    const rawNotif = localStorage.getItem(STORAGE_KEY_NOTIFICATIONS)
    if (rawNotif !== null) notificationsEnabled = rawNotif === 'true'
  } catch {
    // localStorage 불가 — 기본값 사용
  }

  return { theme, toolDensity, notificationsEnabled }
}

interface SettingsState {
  // Claude Code settings (settings.json에서 로드)
  global: Partial<ClaudeSettings>
  project: Partial<ClaudeSettings>
  // effective = deep-merged(global, project) — project가 global을 오버라이드
  effective: Partial<ClaudeSettings>

  // GUI 전용 settings (store에 통합 — localStorage 불필요)
  theme: Theme
  toolDensity: ToolDensity
  notificationsEnabled: boolean

  // 상태
  isLoaded: boolean
  activeScope: 'global' | 'project'

  // 기존 호환 plain property (reactive)
  model: ModelId
  permissionMode: PermissionMode

  // 액션
  initialize: (workspacePath?: string) => Promise<void>
  updateSetting: (scope: 'global' | 'project', key: string, value: unknown, workspacePath?: string) => Promise<void>
  resetProjectSetting: (key: string, workspacePath?: string) => Promise<void>
  setTheme: (theme: Theme) => void
  setToolDensity: (density: ToolDensity) => void
  setNotificationsEnabled: (enabled: boolean) => void

  // 기존 호환 액션
  setModel: (model: ModelId) => void
  setPermissionMode: (mode: PermissionMode) => void
}

// [M1] 중첩 객체(permissions, sandbox)를 deep merge
function computeEffective(
  global: Partial<ClaudeSettings>,
  project: Partial<ClaudeSettings>,
): Partial<ClaudeSettings> {
  const result: Partial<ClaudeSettings> = { ...global, ...project }
  if (global.permissions || project.permissions) {
    result.permissions = { ...global.permissions, ...project.permissions }
  }
  if (global.sandbox || project.sandbox) {
    result.sandbox = { ...global.sandbox, ...project.sandbox }
  }
  return result
}

function extractModel(effective: Partial<ClaudeSettings>): ModelId {
  const m = effective.model
  if (typeof m === 'string' && AVAILABLE_MODELS.includes(m as ModelId)) return m as ModelId
  return 'claude-sonnet-4-6'
}

function extractPermissionMode(effective: Partial<ClaudeSettings>): PermissionMode {
  const mode = effective.permissions?.defaultMode
  return mode === 'auto' ? 'auto' : 'default'
}

// [H1] effective 계산 후 plain property로 포함하는 헬퍼
function deriveFromEffective(global: Partial<ClaudeSettings>, project: Partial<ClaudeSettings>) {
  const effective = computeEffective(global, project)
  return {
    effective,
    model: extractModel(effective),
    permissionMode: extractPermissionMode(effective),
  }
}

function syncNotificationsToMain(enabled: boolean): void {
  window.electronAPI?.invoke(IpcChannel.SETTINGS_SYNC, { notificationsEnabled: enabled })
    .catch(() => { /* preload not ready or channel missing */ })
}

const migrated = migrateFromLocalStorage()

export const useSettingsStore = create<SettingsState>((set, get) => ({
  global: {},
  project: {},
  effective: {},
  theme: migrated.theme,
  toolDensity: migrated.toolDensity,
  notificationsEnabled: migrated.notificationsEnabled,
  isLoaded: false,
  activeScope: 'global',

  // [H1] plain property — Zustand selector에서 reactive하게 동작
  model: 'claude-sonnet-4-6',
  permissionMode: 'default',

  initialize: async (workspacePath?: string) => {
    try {
      const res = await window.electronAPI.invoke(IpcChannel.SETTINGS_READ, { workspacePath })
      const global = res.global ?? {}
      const project = res.project ?? {}
      set({ global, project, ...deriveFromEffective(global, project), isLoaded: true })
    } catch {
      set({ isLoaded: true })
    }
    // 앱 시작 시 notifications 상태를 main process에 동기화
    syncNotificationsToMain(get().notificationsEnabled)
  },

  updateSetting: async (scope, key, value, explicitPath?) => {
    const current = get()
    const updated = { ...current[scope], [key]: value }
    const newGlobal = scope === 'global' ? updated : current.global
    const newProject = scope === 'project' ? updated : current.project
    set({ [scope]: updated, ...deriveFromEffective(newGlobal, newProject) })

    const workspacePath = scope === 'project'
      ? (explicitPath ?? useWorkspaceStore.getState().activeWorkspace ?? undefined)
      : undefined
    await window.electronAPI.invoke(IpcChannel.SETTINGS_WRITE, {
      scope,
      settings: { [key]: value },
      workspacePath,
    })
  },

  resetProjectSetting: async (key, explicitPath?) => {
    const current = get()
    const updatedProject = { ...current.project }
    delete updatedProject[key]
    set({ project: updatedProject, ...deriveFromEffective(current.global, updatedProject) })

    const workspacePath = explicitPath ?? useWorkspaceStore.getState().activeWorkspace ?? undefined
    await window.electronAPI.invoke(IpcChannel.SETTINGS_DELETE_KEY, {
      scope: 'project',
      key,
      workspacePath,
    })
  },

  setTheme: (theme) => {
    document.documentElement.setAttribute('data-theme', theme)
    set({ theme })
  },

  setToolDensity: (density) => {
    set({ toolDensity: density })
  },

  setNotificationsEnabled: (enabled) => {
    set({ notificationsEnabled: enabled })
    syncNotificationsToMain(enabled)
  },

  // 기존 호환 액션 — effective 경유 설정 업데이트
  setModel: (model) => {
    const current = get()
    const updatedGlobal = { ...current.global, model }
    set({ global: updatedGlobal, ...deriveFromEffective(updatedGlobal, current.project) })
    window.electronAPI.invoke(IpcChannel.SETTINGS_WRITE, {
      scope: 'global',
      settings: { model },
    }).catch(() => { /* 저장 실패 무시 */ })
  },

  setPermissionMode: (mode) => {
    const current = get()
    const permissions = { ...current.global.permissions, defaultMode: mode }
    const updatedGlobal = { ...current.global, permissions }
    set({ global: updatedGlobal, ...deriveFromEffective(updatedGlobal, current.project) })
    window.electronAPI.invoke(IpcChannel.SETTINGS_WRITE, {
      scope: 'global',
      settings: { permissions },
    }).catch(() => { /* 저장 실패 무시 */ })
  },
}))

// 앱 시작 시 초기 notifications 동기화 (initialize() 호출 전)
syncNotificationsToMain(migrated.notificationsEnabled)
