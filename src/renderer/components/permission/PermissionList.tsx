import { usePermissionStore } from '../../stores/permission-store'
import { PermissionCard } from './PermissionCard'

export function PermissionList() {
  const queue = usePermissionStore((s) => s.queue)

  if (queue.length === 0) return null

  return (
    <div className="flex flex-col gap-2 border-b border-gray-800 bg-gray-950 px-4 py-3">
      {queue.map((p) => (
        <PermissionCard key={p.requestId} permission={p} />
      ))}
    </div>
  )
}
