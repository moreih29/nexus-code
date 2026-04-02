import { useCallback, useEffect, useRef, useState } from 'react'
import { Group, Panel, Separator } from 'react-resizable-panels'
import { ActivityBar } from './ActivityBar'
import { FlyoutPanel, type FlyoutContentType } from './FlyoutPanel'
import { PanelGrid } from './PanelGrid'
import { BottomPanel } from './BottomPanel'
import { GlobalStatusBar } from './GlobalStatusBar'
import { WorkspaceNameBar } from './WorkspaceNameBar'
import { CommandPalette } from '../shared/CommandPalette'
import { SettingsModal } from '../settings/SettingsModal'
import { ToastContainer } from '../ui/toast'
import { useSettingsStore, type ToolDensity } from '../../stores/settings-store'
import { useWorkspaceStore } from '../../stores/workspace-store'
import { SessionStoreContext, getOrCreateWorkspaceStore, setActiveStore } from '../../stores/session-store'
import { useLayoutStore } from '../../stores/layout-store'
import { MissionControlLayout } from './MissionControlLayout'

const DENSITY_CYCLE: ToolDensity[] = ['compact', 'normal', 'verbose']
const DRAG_DATA_TYPE = 'application/nexus-workspace-path'

export function AppLayout() {
  // ─── 오버레이 상태 ──────────────────────────────────────────────────────────
  const [cmdPaletteOpen, setCmdPaletteOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsScope, setSettingsScope] = useState<'global' | 'project'>('global')
  const [settingsWorkspacePath, setSettingsWorkspacePath] = useState<string | undefined>(undefined)

  // ─── Activity Bar + Flyout ──────────────────────────────────────────────────
  const [flyout, setFlyout] = useState<FlyoutContentType | null>(null)

  const handleFlyoutToggle = useCallback((type: FlyoutContentType) => {
    if (type === 'agents' && useLayoutStore.getState().layoutMode === 'mission-control') return
    setFlyout((prev) => (prev === type ? null : type))
  }, [])

  const handleFlyoutOpen = useCallback((type: FlyoutContentType) => {
    if (type === 'agents' && useLayoutStore.getState().layoutMode === 'mission-control') return
    setFlyout(type)
  }, [])

  // ActivityBar + FlyoutPanel hover zone 딜레이 닫기
  const flyoutCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const handleHoverZoneEnter = useCallback(() => {
    if (flyoutCloseTimer.current) {
      clearTimeout(flyoutCloseTimer.current)
      flyoutCloseTimer.current = null
    }
  }, [])
  const handleHoverZoneLeave = useCallback(() => {
    if (flyout !== null) {
      flyoutCloseTimer.current = setTimeout(() => setFlyout(null), 300)
    }
  }, [flyout])

  // ─── Layout Mode ────────────────────────────────────────────────────────────
  const layoutMode = useLayoutStore((s) => s.layoutMode)

  // ─── Bottom Panel ───────────────────────────────────────────────────────────
  const [bottomPanelVisible, setBottomPanelVisible] = useState(false)

  // ─── 분할 뷰 상태 ──────────────────────────────────────────────────────────
  const activeWorkspace = useWorkspaceStore((s) => s.activeWorkspace)
  const workspaces = useWorkspaceStore((s) => s.workspaces)
  const [splitWorkspaces, setSplitWorkspaces] = useState<[string] | [string, string] | null>(null)
  const [splitDirection, setSplitDirection] = useState<'horizontal' | 'vertical'>('horizontal')
  const [dragOverSlot, setDragOverSlot] = useState<'left' | 'right' | null>(null)

  // activeWorkspace가 변경되면 splitWorkspaces의 첫 번째를 동기화
  useEffect(() => {
    if (activeWorkspace && (!splitWorkspaces || splitWorkspaces.length === 1)) {
      setSplitWorkspaces([activeWorkspace])
    }
  }, [activeWorkspace, splitWorkspaces])

  const handleSplitDrop = useCallback((droppedPath: string) => {
    if (!activeWorkspace || droppedPath === activeWorkspace) return
    setSplitWorkspaces([activeWorkspace, droppedPath])
    setDragOverSlot(null)
  }, [activeWorkspace])

  const handleCloseSplit = useCallback((pathToClose: string) => {
    if (!splitWorkspaces || splitWorkspaces.length !== 2) return
    const remaining = splitWorkspaces.find((p) => p !== pathToClose)
    if (remaining) {
      setSplitWorkspaces([remaining])
      useWorkspaceStore.getState().setActiveWorkspace(remaining)
      setActiveStore(getOrCreateWorkspaceStore(remaining))
    }
  }, [splitWorkspaces])

  // ─── 드래그 이벤트 핸들러 ───────────────────────────────────────────────────
  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer.types.includes(DRAG_DATA_TYPE)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDragOverSlot('right')
  }, [])

  const handleDragLeave = useCallback(() => {
    setDragOverSlot(null)
  }, [])

  const handleDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    const path = e.dataTransfer.getData(DRAG_DATA_TYPE)
    if (path) handleSplitDrop(path)
    setDragOverSlot(null)
  }, [handleSplitDrop])

  // ─── 키보드 단축키 ──────────────────────────────────────────────────────────
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isMac = navigator.platform.toUpperCase().includes('MAC')
      const modKey = isMac ? e.metaKey : e.ctrlKey

      if (modKey && e.key === 'k') {
        e.preventDefault()
        setCmdPaletteOpen((prev) => !prev)
      }

      if (modKey && e.key === 'b') {
        e.preventDefault()
        setFlyout((prev) => (prev === 'workspace' ? null : 'workspace'))
      }

      if (modKey && e.shiftKey && (e.key === 'D' || e.key === 'd')) {
        e.preventDefault()
        const current = useSettingsStore.getState().toolDensity
        const idx = DENSITY_CYCLE.indexOf(current)
        const next = DENSITY_CYCLE[(idx + 1) % DENSITY_CYCLE.length]
        useSettingsStore.getState().setToolDensity(next)
      }

      if (modKey && e.shiftKey && (e.key === 'M' || e.key === 'm')) {
        e.preventDefault()
        const current = useLayoutStore.getState().layoutMode
        useLayoutStore.getState().setLayoutMode(current === 'mission-control' ? 'chat' : 'mission-control')
      }

      // Cmd+Shift+\ — 분할 토글
      if (modKey && e.shiftKey && e.key === '\\') {
        e.preventDefault()
        if (splitWorkspaces && splitWorkspaces.length === 2) {
          // 분할 해제
          handleCloseSplit(splitWorkspaces[1])
        } else if (activeWorkspace && workspaces.length > 1) {
          // 다음 워크스페이스로 분할
          const currentIdx = workspaces.findIndex((ws) => ws.path === activeWorkspace)
          const nextIdx = (currentIdx + 1) % workspaces.length
          const nextWs = workspaces[nextIdx]
          if (nextWs && nextWs.path !== activeWorkspace) {
            setSplitWorkspaces([activeWorkspace, nextWs.path])
          }
        }
      }

      if (e.key === 'Escape') {
        setCmdPaletteOpen(false)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [activeWorkspace, workspaces, splitWorkspaces, handleCloseSplit])

  // ─── 분할 여부 ──────────────────────────────────────────────────────────────
  const isSplit = splitWorkspaces != null && splitWorkspaces.length === 2

  // ─── 워크스페이스 패널 렌더러 ───────────────────────────────────────────────
  function renderWorkspacePanel(wsPath: string, showNameBar: boolean) {
    const ws = workspaces.find((w) => w.path === wsPath)
    const wsName = ws?.name ?? wsPath.split('/').pop() ?? wsPath

    return (
      <SessionStoreContext.Provider value={getOrCreateWorkspaceStore(wsPath)}>
        <div className="flex h-full flex-col overflow-hidden">
          {showNameBar && (
            <WorkspaceNameBar
              name={wsName}
              onClose={() => handleCloseSplit(wsPath)}
            />
          )}
          <div className="min-h-0 flex-1 overflow-hidden">
            <PanelGrid
              workspacePath={wsPath}
              isDragOver={!isSplit && dragOverSlot === 'right'}
              onDragOver={!isSplit ? handleDragOver : undefined}
              onDragLeave={!isSplit ? handleDragLeave : undefined}
              onDrop={!isSplit ? handleDrop : undefined}
            />
          </div>
        </div>
      </SessionStoreContext.Provider>
    )
  }

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground">
      {/* 메인 영역 */}
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        {/* ActivityBar + FlyoutPanel hover zone */}
        <div
          className="relative flex-shrink-0"
          onMouseEnter={handleHoverZoneEnter}
          onMouseLeave={handleHoverZoneLeave}
        >
          <ActivityBar
            activeFlyout={flyout}
            onFlyoutToggle={handleFlyoutToggle}
            onFlyoutOpen={handleFlyoutOpen}
            dragDataType={DRAG_DATA_TYPE}
          />

          <FlyoutPanel
            contentType={flyout}
            isOpen={flyout !== null}
            onClose={() => setFlyout(null)}
            onOpenSettings={() => { setSettingsScope('global'); setSettingsOpen(true) }}
            onOpenWorkspaceSettings={(path: string) => { setSettingsScope('project'); setSettingsWorkspacePath(path); setSettingsOpen(true) }}
          />
        </div>

        {layoutMode === 'mission-control' ? (
          <MissionControlLayout
            bottomPanelVisible={bottomPanelVisible}
            onBottomPanelVisibleChange={setBottomPanelVisible}
          />
        ) : (
          /* PanelGrid (분할 또는 단일) + BottomPanel */
          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            <Group id="chat-vertical" orientation="vertical">
              <Panel id="chat-main" minSize={20}>
                {isSplit ? (
                  <Group id="chat-split" orientation={splitDirection}>
                    <Panel id="chat-split-1" minSize={20}>
                      {renderWorkspacePanel(splitWorkspaces[0], true)}
                    </Panel>
                    <Separator id="chat-split-sep" className="resize-handle" />
                    <Panel id="chat-split-2" minSize={20}>
                      {renderWorkspacePanel(splitWorkspaces[1], true)}
                    </Panel>
                  </Group>
                ) : (
                  activeWorkspace
                    ? renderWorkspacePanel(activeWorkspace, false)
                    : (
                      <div className="flex h-full items-center justify-center">
                        <span className="text-sm text-dim-foreground">워크스페이스를 선택하세요</span>
                      </div>
                    )
                )}
              </Panel>
              {bottomPanelVisible && (
                <>
                  <Separator id="chat-bottom-sep" className="resize-handle" />
                  <Panel id="chat-bottom" defaultSize={30} minSize={10} collapsible>
                    <BottomPanel
                      visible={bottomPanelVisible}
                      onVisibleChange={setBottomPanelVisible}
                    />
                  </Panel>
                </>
              )}
            </Group>
          </div>
        )}
      </div>

      <GlobalStatusBar />

      {/* 오버레이 */}
      <CommandPalette
        isOpen={cmdPaletteOpen}
        onClose={() => setCmdPaletteOpen(false)}
        onOpenSettings={() => { setSettingsScope('global'); setSettingsOpen(true) }}
      />
      <SettingsModal
        isOpen={settingsOpen}
        onClose={() => { setSettingsOpen(false); setSettingsWorkspacePath(undefined) }}
        initialScope={settingsScope}
        workspacePath={settingsWorkspacePath}
      />
      <ToastContainer />
    </div>
  )
}
