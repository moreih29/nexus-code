import { Sidebar } from './Sidebar'
import { MainPanel } from './MainPanel'

export function AppLayout(): JSX.Element {
  return (
    <div className="flex h-screen w-screen overflow-hidden bg-gray-950 text-white">
      <Sidebar />
      <MainPanel />
    </div>
  )
}
