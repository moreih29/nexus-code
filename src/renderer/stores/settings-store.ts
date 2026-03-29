import { create } from 'zustand'
import { IpcChannel } from '../../shared/ipc'

export const AVAILABLE_MODELS = [
  'claude-opus-4-6',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
] as const

export type ModelId = (typeof AVAILABLE_MODELS)[number]
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

const STORAGE_KEY_NOTIFICATIONS = 'nexus:notificationsEnabled'
const STORAGE_KEY_THEME = 'nexus:theme'
const STORAGE_KEY_TOOL_DENSITY = 'nexus:toolDensity'

const VALID_THEMES: Theme[] = ['terracotta', 'github-dark', 'amethyst', 'rose-pine', 'nord', 'midnight-green']

function readTheme(): Theme {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_THEME)
    if (raw && VALID_THEMES.includes(raw as Theme)) return raw as Theme
    return 'terracotta'
  } catch {
    return 'terracotta'
  }
}

function writeTheme(theme: Theme): void {
  try {
    localStorage.setItem(STORAGE_KEY_THEME, theme)
  } catch {
    // localStorage unavailable — ignore
  }
}

function readToolDensity(): ToolDensity {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_TOOL_DENSITY)
    if (raw === 'compact' || raw === 'normal' || raw === 'verbose') return raw
    return 'compact'
  } catch {
    return 'compact'
  }
}

function writeToolDensity(density: ToolDensity): void {
  try {
    localStorage.setItem(STORAGE_KEY_TOOL_DENSITY, density)
  } catch {
    // localStorage unavailable — ignore
  }
}

function readNotificationsEnabled(): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_NOTIFICATIONS)
    if (raw === null) return true
    return raw === 'true'
  } catch {
    return true
  }
}

function writeNotificationsEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY_NOTIFICATIONS, String(enabled))
  } catch {
    // localStorage unavailable — ignore
  }
}

interface SettingsState {
  model: ModelId
  permissionMode: PermissionMode
  notificationsEnabled: boolean
  theme: Theme
  toolDensity: ToolDensity

  setModel: (model: ModelId) => void
  setPermissionMode: (mode: PermissionMode) => void
  setNotificationsEnabled: (enabled: boolean) => void
  setTheme: (theme: Theme) => void
  setToolDensity: (density: ToolDensity) => void
}

const initialNotificationsEnabled = readNotificationsEnabled()
const initialTheme = readTheme()
const initialToolDensity = readToolDensity()

export const useSettingsStore = create<SettingsState>((set) => ({
  model: 'claude-sonnet-4-6',
  permissionMode: 'default',
  notificationsEnabled: initialNotificationsEnabled,
  theme: initialTheme,
  toolDensity: initialToolDensity,

  setModel: (model) => set({ model }),
  setPermissionMode: (mode) => set({ permissionMode: mode }),
  setNotificationsEnabled: (enabled) => {
    writeNotificationsEnabled(enabled)
    set({ notificationsEnabled: enabled })
    syncNotificationsToMain(enabled)
  },
  setTheme: (theme) => {
    writeTheme(theme)
    document.documentElement.setAttribute('data-theme', theme)
    set({ theme })
  },
  setToolDensity: (density) => {
    writeToolDensity(density)
    set({ toolDensity: density })
  },
}))

function syncNotificationsToMain(enabled: boolean): void {
  window.electronAPI
    .invoke(IpcChannel.SETTINGS_SYNC, { notificationsEnabled: enabled })
    .catch(() => { /* preload not ready or channel missing */ })
}

// 앱 시작 시 저장된 설정을 main process에 동기화
syncNotificationsToMain(initialNotificationsEnabled)
