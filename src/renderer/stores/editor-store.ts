import { create } from 'zustand'

// ─── 에디터 열기 요청 타입 ──────────────────────────────────────────────────────

export interface OpenFileRequest {
  id: string
  filePath: string
  content?: string
  language?: string
  isTemporary?: boolean
  /** Edit 도구 결과에서 변경된 라인 하이라이트용 */
  diffHighlight?: { oldString: string; newString: string }
}

interface EditorCommandState {
  /** 에디터에서 소비할 파일 열기 요청 큐 */
  pendingOpen: OpenFileRequest | null

  /** 에디터 패널이 현재 열려있는지 (PanelGrid에서 추적) */
  editorVisible: boolean

  requestOpenFile: (req: Omit<OpenFileRequest, 'id'>) => void
  consumeOpenRequest: () => OpenFileRequest | null
  setEditorVisible: (visible: boolean) => void
}

export const useEditorStore = create<EditorCommandState>((set, get) => ({
  pendingOpen: null,
  editorVisible: false,

  requestOpenFile: (req) => {
    set({ pendingOpen: { ...req, id: `open-${Date.now()}` } })
  },

  consumeOpenRequest: () => {
    const { pendingOpen } = get()
    if (!pendingOpen) return null
    set({ pendingOpen: null })
    return pendingOpen
  },

  setEditorVisible: (visible) => set({ editorVisible: visible }),
}))
