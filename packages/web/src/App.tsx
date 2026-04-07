import { useEffect, useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AppLayout } from './components/layout/app-layout'
import { CommandPalette, type Command } from './components/layout/command-palette'
import { GlobalSettingsDialog } from './components/settings/global-settings-dialog'
import { WorkspaceNav } from './components/workspace/workspace-nav'
import { ChatArea } from './components/chat/chat-area'
import { RightPanel } from './components/panel/right-panel'
import { useChatStore } from './stores/chat-store'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 30_000,
    },
  },
})

function AppWithCommands() {
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const resetSession = useChatStore((s) => s.resetSession)

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const isMac = navigator.platform.toUpperCase().includes('MAC')
      const modifier = isMac ? e.metaKey : e.ctrlKey

      if (modifier && e.key === 'k') {
        e.preventDefault()
        setPaletteOpen((prev) => !prev)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  const commands: Command[] = [
    {
      id: 'new-session',
      label: '새 세션 시작',
      description: '현재 대화를 초기화하고 새 세션을 시작합니다',
      action: () => {
        resetSession()
      },
    },
    {
      id: 'open-settings',
      label: '설정 열기',
      description: '모델, 권한 모드, 테마 등 전역 설정',
      shortcut: '⌘,',
      action: () => {
        setSettingsOpen(true)
      },
    },
    {
      id: 'change-theme',
      label: '테마 변경',
      description: '앱 테마를 변경합니다',
      action: () => {
        setSettingsOpen(true)
      },
    },
  ]

  return (
    <>
      <AppLayout left={<WorkspaceNav />} center={<ChatArea />} right={<RightPanel />} />
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        commands={commands}
      />
      <GlobalSettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </>
  )
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AppWithCommands />
    </QueryClientProvider>
  )
}
