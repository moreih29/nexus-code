import { Sidebar } from './Sidebar'
import { MainPanel } from './MainPanel'

export function AppLayout() {
  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background text-foreground">
      <Sidebar />
      <MainPanel />
    </div>
  )
}
