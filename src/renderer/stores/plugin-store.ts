import { create } from 'zustand'
import type { PluginDataEvent } from '../../shared/types'

interface PluginState {
  /** pluginId → panelId → data */
  panels: Record<string, Record<string, unknown>>
  handlePluginData: (event: PluginDataEvent) => void
  clear: () => void
}

export const usePluginStore = create<PluginState>((set) => ({
  panels: {},

  handlePluginData: (event) =>
    set((s) => ({
      panels: {
        ...s.panels,
        [event.pluginId]: {
          ...(s.panels[event.pluginId] ?? {}),
          [event.panelId]: event.data,
        },
      },
    })),

  clear: () => set({ panels: {} }),
}))

/** 특정 플러그인/패널 데이터 셀렉터 */
export function usePanelData<T = unknown>(pluginId: string, panelId: string): T | undefined {
  return usePluginStore((s) => s.panels[pluginId]?.[panelId] as T | undefined)
}

// ─── RightPanel UI 상태 ────────────────────────────────────────────────────

export type RightPanelTab = 'nexus' | 'markdown' | 'timeline' | 'changes'

const TAB_PRIORITY: Record<RightPanelTab, number> = {
  changes: 4,
  timeline: 3,
  nexus: 2,
  markdown: 1,
}

interface RightPanelUIState {
  activeTab: RightPanelTab
  isPinned: boolean
  setActiveTab: (tab: RightPanelTab) => void
  requestAutoSwitch: (tab: RightPanelTab) => void
  pinTab: (tab: RightPanelTab) => void
  unpinTab: () => void
  cleanup: () => void
}

// 모듈 레벨 타이머 변수
let _autoSwitchTimer: ReturnType<typeof setTimeout> | null = null
let _unpinTimer: ReturnType<typeof setTimeout> | null = null

export const useRightPanelUIStore = create<RightPanelUIState>((set, get) => ({
  activeTab: 'nexus',
  isPinned: false,

  setActiveTab: (tab) => set({ activeTab: tab }),

  requestAutoSwitch: (tab) => {
    const { isPinned, activeTab } = get()

    // pin 상태이면 자동 전환 무시
    if (isPinned) return

    // 현재 탭보다 우선순위가 낮으면 무시
    if (TAB_PRIORITY[tab] <= TAB_PRIORITY[activeTab]) return

    // 기존 디바운스 타이머 취소
    if (_autoSwitchTimer !== null) {
      clearTimeout(_autoSwitchTimer)
    }

    // 500ms 디바운스 후 전환
    _autoSwitchTimer = setTimeout(() => {
      _autoSwitchTimer = null
      set({ activeTab: tab })
    }, 500)
  },

  pinTab: (tab) => {
    // 기존 타이머 모두 취소 (디바운스 중인 자동 전환 포함)
    if (_unpinTimer !== null) {
      clearTimeout(_unpinTimer)
    }
    if (_autoSwitchTimer !== null) {
      clearTimeout(_autoSwitchTimer)
      _autoSwitchTimer = null
    }

    set({ activeTab: tab, isPinned: true })

    // 30초 후 자동 unpin
    _unpinTimer = setTimeout(() => {
      _unpinTimer = null
      set({ isPinned: false })
    }, 30_000)
  },

  unpinTab: () => {
    if (_unpinTimer !== null) {
      clearTimeout(_unpinTimer)
      _unpinTimer = null
    }
    set({ isPinned: false })
  },

  cleanup: () => {
    if (_autoSwitchTimer !== null) {
      clearTimeout(_autoSwitchTimer)
      _autoSwitchTimer = null
    }
    if (_unpinTimer !== null) {
      clearTimeout(_unpinTimer)
      _unpinTimer = null
    }
    set({ isPinned: false })
  },
}))
