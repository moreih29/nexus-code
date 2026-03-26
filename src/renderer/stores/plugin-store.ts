import { create } from 'zustand'
import type { PluginDataEvent } from '../../shared/types'

interface PluginState {
  /** pluginId → panelId → data */
  panels: Record<string, Record<string, unknown>>
  handlePluginData: (event: PluginDataEvent) => void
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
}))

/** 특정 플러그인/패널 데이터 셀렉터 */
export function usePanelData<T = unknown>(pluginId: string, panelId: string): T | undefined {
  return usePluginStore((s) => s.panels[pluginId]?.[panelId] as T | undefined)
}
