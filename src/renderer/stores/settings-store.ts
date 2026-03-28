import { create } from 'zustand'
import { IpcChannel } from '../../shared/ipc'

export const AVAILABLE_MODELS = [
  'claude-opus-4-6',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
] as const

export type ModelId = (typeof AVAILABLE_MODELS)[number]
export type PermissionMode = 'auto' | 'default'

const STORAGE_KEY_NOTIFICATIONS = 'nexus:notificationsEnabled'

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

  setModel: (model: ModelId) => void
  setPermissionMode: (mode: PermissionMode) => void
  setNotificationsEnabled: (enabled: boolean) => void
}

const initialNotificationsEnabled = readNotificationsEnabled()

export const useSettingsStore = create<SettingsState>((set) => ({
  model: 'claude-sonnet-4-6',
  permissionMode: 'default',
  notificationsEnabled: initialNotificationsEnabled,

  setModel: (model) => set({ model }),
  setPermissionMode: (mode) => set({ permissionMode: mode }),
  setNotificationsEnabled: (enabled) => {
    writeNotificationsEnabled(enabled)
    set({ notificationsEnabled: enabled })
    syncNotificationsToMain(enabled)
  },
}))

function syncNotificationsToMain(enabled: boolean): void {
  window.electronAPI
    .invoke(IpcChannel.SETTINGS_SYNC, { notificationsEnabled: enabled })
    .catch(() => { /* preload not ready or channel missing */ })
}

// 앱 시작 시 저장된 설정을 main process에 동기화
syncNotificationsToMain(initialNotificationsEnabled)
