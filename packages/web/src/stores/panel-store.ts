import { create } from 'zustand'

type RightTab = 'files' | 'git' | 'browser'
type RightView = RightTab | 'editor'

interface PanelState {
  rightTab: RightTab
  rightView: RightView
  subagentPanelCollapsed: boolean
  subagentPanelHidden: boolean
  openFilePath: string | null

  setRightTab: (tab: RightTab) => void
  setRightView: (view: RightView) => void
  openFile: (path: string) => void
  toggleSubagentPanel: () => void
  setSubagentPanelHidden: (hidden: boolean) => void
}

export const usePanelStore = create<PanelState>((set, get) => ({
  rightTab: 'files',
  rightView: 'files',
  subagentPanelCollapsed: false,
  subagentPanelHidden: false,
  openFilePath: null,

  setRightTab: (tab) => set({ rightTab: tab, rightView: tab }),

  setRightView: (view) => set({ rightView: view }),

  openFile: (path) => set({ rightView: 'editor', openFilePath: path }),

  toggleSubagentPanel: () => set((s) => ({ subagentPanelCollapsed: !s.subagentPanelCollapsed })),

  setSubagentPanelHidden: (hidden) => set({ subagentPanelHidden: hidden }),
}))
