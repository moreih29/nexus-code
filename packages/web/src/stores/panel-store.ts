import { create } from 'zustand'
import { mockFileTree, mockGitChanges, mockGitCommits, type MockFileNode, type MockGitChange, type MockGitCommit } from '../mock/data.js'

type RightTab = 'files' | 'git' | 'browser'
type RightView = RightTab | 'editor'

interface PanelState {
  rightTab: RightTab
  rightView: RightView
  subagentPanelCollapsed: boolean
  subagentPanelHidden: boolean
  fileTree: MockFileNode[]
  gitChanges: MockGitChange[]
  gitCommits: MockGitCommit[]
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
  fileTree: mockFileTree,
  gitChanges: mockGitChanges,
  gitCommits: mockGitCommits,
  openFilePath: null,

  setRightTab: (tab) => set({ rightTab: tab, rightView: tab }),

  setRightView: (view) => set({ rightView: view }),

  openFile: (path) => set({ rightView: 'editor', openFilePath: path }),

  toggleSubagentPanel: () => set((s) => ({ subagentPanelCollapsed: !s.subagentPanelCollapsed })),

  setSubagentPanelHidden: (hidden) => set({ subagentPanelHidden: hidden }),
}))
