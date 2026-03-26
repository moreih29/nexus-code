import { ChatPanel } from '../chat/ChatPanel'
import { PermissionList } from '../permission/PermissionList'

export function MainPanel(): JSX.Element {
  return (
    <main className="flex h-full flex-1 flex-col bg-gray-950">
      <PermissionList />
      <ChatPanel />
    </main>
  )
}
