import { useEffect } from 'react'
import { IpcChannel } from '../../../shared/ipc'
import type { PermissionRequestEvent } from '../../../shared/types'
import { usePermissionStore } from '../../stores/permission-store'
import { PermissionCard } from './PermissionCard'

export function PermissionList(): JSX.Element | null {
  const { queue, add } = usePermissionStore()

  useEffect(() => {
    const onPermissionRequest = (event: PermissionRequestEvent): void => {
      add({
        requestId: event.requestId,
        toolName: event.toolName,
        input: event.input,
        agentId: event.agentId,
        timestamp: Date.now(),
      })
    }

    window.electronAPI.on(
      IpcChannel.PERMISSION_REQUEST,
      onPermissionRequest as (...args: unknown[]) => void,
    )

    return () => {
      window.electronAPI.off(
        IpcChannel.PERMISSION_REQUEST,
        onPermissionRequest as (...args: unknown[]) => void,
      )
    }
  }, [add])

  if (queue.length === 0) return null

  return (
    <div className="flex flex-col gap-2 border-b border-gray-800 bg-gray-950 px-4 py-3">
      {queue.map((p) => (
        <PermissionCard key={p.requestId} permission={p} />
      ))}
    </div>
  )
}
