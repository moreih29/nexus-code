import { useState, type ReactNode } from 'react'
import { Plus, X } from 'lucide-react'
import { Group, Panel, Separator } from 'react-resizable-panels'
import { cn } from '../../lib/utils'
import { useLayoutStore } from '../../stores/layout-store'
import { useWorkspaceStore } from '../../stores/workspace-store'
import type { PanelType, PanelLayoutNode } from '../../../shared/types'
import { ChatPanel } from '../chat/ChatPanel'
import { EditorPanel } from '../editor/EditorPanel'
import { BrowserPanel } from '../browser/BrowserPanel'

// ─── 패널 타입 레지스트리 ─────────────────────────────────────────────────────

const PANEL_LABELS: Record<PanelType, string> = {
  chat: 'Chat',
  editor: 'Editor',
  browser: 'Browser',
  'markdown-preview': 'Preview',
  timeline: 'Timeline',
}

function PanelContent({ type }: { type: PanelType }) {
  if (type === 'chat') return <ChatPanel />
  if (type === 'editor') return <EditorPanel />
  if (type === 'browser') return <BrowserPanel />
  return (
    <div className="flex h-full items-center justify-center">
      <span className="text-sm text-dim-foreground">{PANEL_LABELS[type]} — 준비 중</span>
    </div>
  )
}

// ─── Panel Tab Bar ────────────────────────────────────────────────────────────

const ADD_PANEL_OPTIONS: { type: PanelType; label: string }[] = [
  { type: 'chat', label: 'Chat' },
  { type: 'editor', label: 'Editor' },
  { type: 'browser', label: 'Browser' },
  { type: 'markdown-preview', label: 'Preview' },
  { type: 'timeline', label: 'Timeline' },
]

interface PanelTabBarProps {
  panels: Array<{ id: string; type: PanelType; size: number }>
  activeId: string
  isFocused: boolean
  onActivate: (id: string) => void
  onClose: (id: string) => void
  onAdd: (type: PanelType) => void
  onFocus: () => void
}

function PanelTabBar({ panels, activeId, isFocused, onActivate, onClose, onAdd, onFocus }: PanelTabBarProps) {
  const [addOpen, setAddOpen] = useState(false)

  return (
    <div
      className={cn(
        'flex h-9 shrink-0 items-center border-b border-border bg-card',
        isFocused ? 'border-t-2 border-t-primary' : 'border-t-2 border-t-transparent opacity-80',
      )}
      onClick={onFocus}
    >
      <div className="flex min-w-0 flex-1 items-center overflow-x-auto">
        {panels.map((panel) => (
          <div
            key={panel.id}
            className={cn(
              'group flex h-full shrink-0 cursor-pointer items-center gap-1 border-b-2 px-3 text-xs transition-colors',
              panel.id === activeId
                ? 'border-b-primary bg-primary/8 font-semibold text-primary'
                : 'border-b-transparent font-medium text-muted-foreground hover:bg-muted/50 hover:text-foreground',
            )}
            onClick={(e) => { e.stopPropagation(); onActivate(panel.id) }}
          >
            <span>{PANEL_LABELS[panel.type]}</span>
            {panels.length > 1 && (
              <button
                onClick={(e) => { e.stopPropagation(); onClose(panel.id) }}
                className="hidden rounded p-0.5 hover:bg-muted group-hover:flex"
                title="닫기"
              >
                <X size={10} />
              </button>
            )}
          </div>
        ))}
      </div>

      {/* [+] 새 패널 추가 */}
      <div className="relative shrink-0 px-1">
        <button
          onClick={(e) => { e.stopPropagation(); setAddOpen((v) => !v) }}
          className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
          title="패널 추가"
        >
          <Plus size={12} />
        </button>
        {addOpen && (
          <div className="absolute right-0 top-full z-50 mt-1 min-w-32 rounded-md border border-border bg-popover shadow-md">
            {ADD_PANEL_OPTIONS.map((opt) => (
              <button
                key={opt.type}
                onClick={() => { onAdd(opt.type); setAddOpen(false) }}
                className="flex w-full items-center px-3 py-1.5 text-xs hover:bg-muted transition-colors"
              >
                {opt.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── 패널 그룹 노드 (재귀) ────────────────────────────────────────────────────

interface PanelNodeProps {
  node: PanelLayoutNode
  workspacePath: string
  focusedPanel: string | null
  onFocusPanel: (id: string) => void
}

function PanelNode({ node, workspacePath, focusedPanel, onFocusPanel }: PanelNodeProps) {
  const updateLayout = useLayoutStore((s) => s.updateLayout)
  const getOrCreateLayout = useLayoutStore((s) => s.getOrCreateLayout)

  // 현재 노드의 활성 탭 (첫 번째 패널 기본)
  const [activeId, setActiveId] = useState(() => node.panels[0]?.id ?? '')

  const handleClose = (panelId: string) => {
    if (node.panels.length <= 1) return
    const layout = getOrCreateLayout(workspacePath)
    const newPanels = node.panels.filter((p) => p.id !== panelId)
    updateLayout(workspacePath, {
      root: { ...layout.root, panels: newPanels },
    })
    if (activeId === panelId) setActiveId(newPanels[0]?.id ?? '')
  }

  const handleAdd = (type: PanelType) => {
    const layout = getOrCreateLayout(workspacePath)
    const newPanel = { id: `panel-${Date.now()}`, type, size: 100 / (node.panels.length + 1) }
    updateLayout(workspacePath, {
      root: { ...layout.root, panels: [...node.panels, newPanel] },
    })
    setActiveId(newPanel.id)
  }

  const activePanel = node.panels.find((p) => p.id === activeId) ?? node.panels[0]
  const isFocused = focusedPanel === activeId

  // 자식 노드가 있으면 재귀 분할
  if (node.children && node.children.length > 0) {
    const items: ReactNode[] = []
    node.children.forEach((child, idx) => {
      if (idx > 0) {
        items.push(<Separator key={`sep-${idx}`} className="resize-handle" />)
      }
      items.push(
        <Panel key={`child-${idx}`} minSize={10}>
          <PanelNode
            node={child}
            workspacePath={workspacePath}
            focusedPanel={focusedPanel}
            onFocusPanel={onFocusPanel}
          />
        </Panel>,
      )
    })
    return (
      <Group orientation={node.orientation} className="h-full w-full">
        {items}
      </Group>
    )
  }

  return (
    <div
      className="flex h-full flex-col"
      onClick={() => onFocusPanel(activeId)}
    >
      <PanelTabBar
        panels={node.panels}
        activeId={activeId}
        isFocused={isFocused}
        onActivate={setActiveId}
        onClose={handleClose}
        onAdd={handleAdd}
        onFocus={() => onFocusPanel(activeId)}
      />
      <div className="min-h-0 flex-1 overflow-hidden">
        {activePanel && <PanelContent type={activePanel.type} />}
      </div>
    </div>
  )
}

// ─── PanelGrid ────────────────────────────────────────────────────────────────

export function PanelGrid() {
  const activeWorkspace = useWorkspaceStore((s) => s.activeWorkspace)
  const getOrCreateLayout = useLayoutStore((s) => s.getOrCreateLayout)
  const focusedPanel = useLayoutStore((s) => s.focusedPanel)
  const setFocusedPanel = useLayoutStore((s) => s.setFocusedPanel)

  if (!activeWorkspace) {
    return (
      <div className="flex h-full items-center justify-center">
        <span className="text-sm text-dim-foreground">워크스페이스를 선택하세요</span>
      </div>
    )
  }

  const layout = getOrCreateLayout(activeWorkspace)

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      <PanelNode
        node={layout.root}
        workspacePath={activeWorkspace}
        focusedPanel={focusedPanel}
        onFocusPanel={setFocusedPanel}
      />
    </div>
  )
}
