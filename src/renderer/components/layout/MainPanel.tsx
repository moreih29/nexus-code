import { ChatPanel } from '../chat/ChatPanel'

export function MainPanel() {
  return (
    <main className="flex h-full flex-1 flex-col bg-background">
      <ChatPanel />
    </main>
  )
}
