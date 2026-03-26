import { WorkspaceList } from '../workspace/WorkspaceList'

export function Sidebar(): JSX.Element {
  return (
    <aside className="flex h-full w-[250px] shrink-0 flex-col border-r border-gray-800 bg-gray-900">
      <div className="flex h-12 items-center border-b border-gray-800 px-4">
        <span className="text-sm font-semibold text-gray-300">Workspaces</span>
      </div>
      <div className="min-h-0 flex-1">
        <WorkspaceList />
      </div>
    </aside>
  )
}
