import { useCallback, useEffect, useState } from 'react'
import { Group, Panel, Separator } from 'react-resizable-panels'
import { ActivityBar } from './ActivityBar'
import { FlyoutPanel, type FlyoutContentType } from './FlyoutPanel'
import { PanelGrid } from './PanelGrid'
import { BottomPanel } from './BottomPanel'
import { GlobalStatusBar } from './GlobalStatusBar'
import { CommandPalette } from '../shared/CommandPalette'
import { SettingsModal } from '../settings/SettingsModal'
import { ToastContainer } from '../ui/toast'
import { useSettingsStore, type ToolDensity } from '../../stores/settings-store'

const DENSITY_CYCLE: ToolDensity[] = ['compact', 'normal', 'verbose']

export function AppLayout() {
  // ─── 오버레이 상태 ──────────────────────────────────────────────────────────
  const [cmdPaletteOpen, setCmdPaletteOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsScope, setSettingsScope] = useState<'global' | 'project'>('global')
  const [settingsWorkspacePath, setSettingsWorkspacePath] = useState<string | undefined>(undefined)

  // ─── Activity Bar + Flyout ──────────────────────────────────────────────────
  const [flyout, setFlyout] = useState<FlyoutContentType | null>(null)

  const handleFlyoutToggle = useCallback((type: FlyoutContentType) => {
    setFlyout((prev) => (prev === type ? null : type))
  }, [])

  // ─── Bottom Panel ───────────────────────────────────────────────────────────
  const [bottomPanelVisible, setBottomPanelVisible] = useState(false)

  // ─── 키보드 단축키 ──────────────────────────────────────────────────────────
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isMac = navigator.platform.toUpperCase().includes('MAC')
      const modKey = isMac ? e.metaKey : e.ctrlKey

      // Cmd+K — 커맨드 팔레트
      if (modKey && e.key === 'k') {
        e.preventDefault()
        setCmdPaletteOpen((prev) => !prev)
      }

      // Cmd+B — 플라이아웃(탐색기) 토글
      if (modKey && e.key === 'b') {
        e.preventDefault()
        setFlyout((prev) => (prev === 'workspace' ? null : 'workspace'))
      }

      // Cmd+Shift+D — 도구 밀도 전환
      if (modKey && e.shiftKey && (e.key === 'D' || e.key === 'd')) {
        e.preventDefault()
        const current = useSettingsStore.getState().toolDensity
        const idx = DENSITY_CYCLE.indexOf(current)
        const next = DENSITY_CYCLE[(idx + 1) % DENSITY_CYCLE.length]
        useSettingsStore.getState().setToolDensity(next)
      }

      // Escape — 팔레트 닫기
      if (e.key === 'Escape') {
        setCmdPaletteOpen(false)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground">
      {/* 메인 영역: ActivityBar + Flyout + PanelGrid + BottomPanel */}
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        {/* Activity Bar (좌측 고정 44px) */}
        <ActivityBar activeFlyout={flyout} onFlyoutToggle={handleFlyoutToggle} />

        {/* Flyout (absolute 오버레이) */}
        <FlyoutPanel
          contentType={flyout}
          isOpen={flyout !== null}
          onClose={() => setFlyout(null)}
          onOpenSettings={() => { setSettingsScope('global'); setSettingsOpen(true) }}
          onOpenWorkspaceSettings={(path: string) => { setSettingsScope('project'); setSettingsWorkspacePath(path); setSettingsOpen(true) }}
        />

        {/* PanelGrid + BottomPanel (수직 분할) */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <Group orientation="vertical">
            <Panel minSize={20}>
              <PanelGrid />
            </Panel>
            {bottomPanelVisible && (
              <>
                <Separator className="resize-handle" />
                <Panel defaultSize={30} minSize={10} collapsible>
                  <BottomPanel
                    visible={bottomPanelVisible}
                    onVisibleChange={setBottomPanelVisible}
                  />
                </Panel>
              </>
            )}
          </Group>
        </div>
      </div>

      {/* Global Status Bar (최하단 24px) */}
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
