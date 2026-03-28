import { useEffect, useState } from 'react'
import { Sidebar } from './Sidebar'
import { MainPanel } from './MainPanel'
import { RightPanel } from './RightPanel'
import { CommandPalette } from '../shared/CommandPalette'
import { SettingsModal } from '../settings/SettingsModal'

export function AppLayout() {
  const [cmdPaletteOpen, setCmdPaletteOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)

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
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background text-foreground">
      <Sidebar />
      <MainPanel />
      <RightPanel />
      <CommandPalette
        isOpen={cmdPaletteOpen}
        onClose={() => setCmdPaletteOpen(false)}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <SettingsModal isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  )
}
