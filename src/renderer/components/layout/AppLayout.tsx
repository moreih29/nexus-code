import { Sidebar } from './Sidebar'
import { MainPanel } from './MainPanel'
import { RightPanel } from './RightPanel'

export function AppLayout() {
  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background text-foreground">
      <Sidebar />
      <MainPanel />
      <RightPanel />
    </div>
  )
}
