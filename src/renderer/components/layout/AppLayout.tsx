import { useEffect, useState } from 'react'
import { Menu } from 'lucide-react'
import { Sidebar } from './Sidebar'
import { MainPanel } from './MainPanel'
import { RightPanel } from './RightPanel'
import { CommandPalette } from '../shared/CommandPalette'
import { SettingsModal } from '../settings/SettingsModal'

export function AppLayout() {
  const [cmdPaletteOpen, setCmdPaletteOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [isCompact, setIsCompact] = useState(false)
  const [isNarrow, setIsNarrow] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(false)

  useEffect(() => {
    const compactMq = window.matchMedia('(max-width: 900px)')
    const narrowMq = window.matchMedia('(max-width: 700px)')

    setIsCompact(compactMq.matches)
    setIsNarrow(narrowMq.matches)

    const onCompactChange = (e: MediaQueryListEvent) => setIsCompact(e.matches)
    const onNarrowChange = (e: MediaQueryListEvent) => {
      setIsNarrow(e.matches)
      if (!e.matches) setSidebarOpen(false)
    }

    compactMq.addEventListener('change', onCompactChange)
    narrowMq.addEventListener('change', onNarrowChange)
    return () => {
      compactMq.removeEventListener('change', onCompactChange)
      narrowMq.removeEventListener('change', onNarrowChange)
    }
  }, [])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isMac = navigator.platform.toUpperCase().includes('MAC')
      const modKey = isMac ? e.metaKey : e.ctrlKey

      if (modKey && e.key === 'k') {
        e.preventDefault()
        setCmdPaletteOpen((prev) => !prev)
      }

      if (e.key === 'Escape') {
        setCmdPaletteOpen(false)
        setSidebarOpen(false)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  return (
    <div className="relative flex h-screen w-screen overflow-hidden bg-background text-foreground">
      {isNarrow && (
        <button
          onClick={() => setSidebarOpen((prev) => !prev)}
          className="absolute left-3 top-3 z-50 rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
          title="사이드바 열기"
        >
          <Menu size={18} />
        </button>
      )}
      <Sidebar
        overlay={isNarrow}
        open={isNarrow ? sidebarOpen : true}
        onClose={() => setSidebarOpen(false)}
      />
      <MainPanel />
      <RightPanel forceCollapsed={isCompact} />
      <CommandPalette
        isOpen={cmdPaletteOpen}
        onClose={() => setCmdPaletteOpen(false)}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <SettingsModal isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  )
}
