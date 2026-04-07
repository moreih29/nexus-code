import { create } from 'zustand'

export type RightPanelMode = 'normal' | 'collapsed' | 'expanded'

interface LayoutState {
  rightPanelMode: RightPanelMode
  rightPanelWidth: number
  setRightPanelMode: (mode: RightPanelMode) => void
  setRightPanelWidth: (width: number) => void
}

export const useLayoutStore = create<LayoutState>((set) => ({
  rightPanelMode: 'normal',
  rightPanelWidth: 340,
  setRightPanelMode: (mode) => set({ rightPanelMode: mode }),
  setRightPanelWidth: (width) => set({ rightPanelWidth: width }),
}))
