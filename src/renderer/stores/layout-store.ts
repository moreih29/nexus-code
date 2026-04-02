import { create } from 'zustand'
import type { PanelType, WorkspaceLayout } from '../../shared/types'

// ─── 기본 레이아웃 팩토리 ────────────────────────────────────────────────────

function createDefaultLayout(): WorkspaceLayout {
  return {
    root: {
      panels: [{ id: 'chat-main', type: 'chat' as PanelType, size: 100 }],
      orientation: 'horizontal',
    },
    openFiles: [],
    activeFile: null,
    browserUrl: null,
    chatScrollPosition: 0,
    bottomPanelVisible: false,
    bottomPanelHeight: 30,
  }
}

export type LayoutMode = 'chat' | 'mission-control'

// ─── 스토어 상태 타입 ────────────────────────────────────────────────────────

interface LayoutStoreState {
  /** 워크스페이스 경로 → 레이아웃 매핑 */
  layouts: Map<string, WorkspaceLayout>
  /** 현재 포커스된 패널 ID */
  focusedPanel: string | null
  /** 레이아웃 모드 */
  layoutMode: LayoutMode

  getOrCreateLayout: (workspacePath: string) => WorkspaceLayout
  updateLayout: (workspacePath: string, partial: Partial<WorkspaceLayout>) => void
  setFocusedPanel: (panelId: string | null) => void
  removeLayout: (workspacePath: string) => void
  setLayoutMode: (mode: LayoutMode) => void
}

// ─── 스토어 ──────────────────────────────────────────────────────────────────

export const useLayoutStore = create<LayoutStoreState>()((set, get) => ({
  layouts: new Map(),
  focusedPanel: null,
  layoutMode: 'chat',

  getOrCreateLayout: (workspacePath) => {
    const { layouts } = get()
    if (!layouts.has(workspacePath)) {
      const newLayout = createDefaultLayout()
      const newLayouts = new Map(layouts)
      newLayouts.set(workspacePath, newLayout)
      set({ layouts: newLayouts })
      return newLayout
    }
    return layouts.get(workspacePath)!
  },

  updateLayout: (workspacePath, partial) => {
    const { layouts } = get()
    const existing = layouts.get(workspacePath) ?? createDefaultLayout()
    const newLayouts = new Map(layouts)
    newLayouts.set(workspacePath, { ...existing, ...partial })
    set({ layouts: newLayouts })
  },

  setFocusedPanel: (panelId) => set({ focusedPanel: panelId }),

  removeLayout: (workspacePath) => {
    const { layouts } = get()
    const newLayouts = new Map(layouts)
    newLayouts.delete(workspacePath)
    set({ layouts: newLayouts })
  },

  setLayoutMode: (mode) => set({ layoutMode: mode }),
}))
