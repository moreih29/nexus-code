import { useEffect, useRef, useState } from 'react'
import { Group, Panel, Separator, usePanelRef } from 'react-resizable-panels'
import { Sidebar } from './Sidebar'
import { MainPanel } from './MainPanel'
import { RightPanel } from './RightPanel'
import { CommandPalette } from '../shared/CommandPalette'
import { SettingsModal } from '../settings/SettingsModal'
import { ToastContainer } from '../ui/toast'
import { useSettingsStore, type ToolDensity } from '../../stores/settings-store'

const DENSITY_CYCLE: ToolDensity[] = ['compact', 'normal', 'verbose']

function ResizeHandle({ onDoubleClick }: { onDoubleClick?: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el || !onDoubleClick) return
    el.addEventListener('dblclick', onDoubleClick)
    return () => el.removeEventListener('dblclick', onDoubleClick)
  }, [onDoubleClick])
  return <Separator elementRef={ref} className="resize-handle" />
}

const COLLAPSED_SIZE = 48

export function AppLayout() {
  const [cmdPaletteOpen, setCmdPaletteOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [rightCollapsed, setRightCollapsed] = useState(false)
  const sidebarRef = usePanelRef()
  const rightPanelRef = usePanelRef()

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
        if (sidebarRef.current?.isCollapsed()) {
          sidebarRef.current.expand()
        } else {
          sidebarRef.current?.collapse()
        }
      }

      if (modKey && e.shiftKey && (e.key === 'D' || e.key === 'd')) {
        e.preventDefault()
        const current = useSettingsStore.getState().toolDensity
        const idx = DENSITY_CYCLE.indexOf(current)
        const next = DENSITY_CYCLE[(idx + 1) % DENSITY_CYCLE.length]
        useSettingsStore.getState().setToolDensity(next)
      }

      if (e.key === 'Escape') {
        setCmdPaletteOpen(false)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [sidebarRef])

  const toggleSidebar = () => {
    if (sidebarRef.current?.isCollapsed()) {
      sidebarRef.current.expand()
    } else {
      sidebarRef.current?.collapse()
    }
  }

  const toggleRightPanel = () => {
    if (rightPanelRef.current?.isCollapsed()) {
      rightPanelRef.current.expand()
    } else {
      rightPanelRef.current?.collapse()
    }
  }

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background text-foreground">
      <Group orientation="horizontal" className="h-full w-full">
        <Panel
          panelRef={sidebarRef}
          defaultSize="18%"
          minSize={200}
          collapsible
          collapsedSize={COLLAPSED_SIZE}
          onResize={(size) => setSidebarCollapsed(size.inPixels <= COLLAPSED_SIZE)}
        >
          <Sidebar onToggle={toggleSidebar} isCollapsed={sidebarCollapsed} onOpenSettings={() => setSettingsOpen(true)} />
        </Panel>
        <ResizeHandle onDoubleClick={toggleSidebar} />
        <Panel minSize={400}>
          <MainPanel />
        </Panel>
        <ResizeHandle onDoubleClick={toggleRightPanel} />
        <Panel
          panelRef={rightPanelRef}
          defaultSize="25%"
          minSize={250}
          collapsible
          collapsedSize={COLLAPSED_SIZE}
          onResize={(size) => setRightCollapsed(size.inPixels <= COLLAPSED_SIZE)}
        >
          <RightPanel onToggle={toggleRightPanel} isCollapsed={rightCollapsed} />
        </Panel>
      </Group>
      <CommandPalette
        isOpen={cmdPaletteOpen}
        onClose={() => setCmdPaletteOpen(false)}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <SettingsModal isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <ToastContainer />
    </div>
  )
}
