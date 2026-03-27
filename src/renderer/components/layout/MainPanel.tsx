import { ChatPanel } from '../chat/ChatPanel'
import { PermissionList } from '../permission/PermissionList'

export function MainPanel() {
  return (
    <main className="flex h-full flex-1 flex-col bg-background">
      <PermissionList />
      <ChatPanel />
    </main>
  )
}
