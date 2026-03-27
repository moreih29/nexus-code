import log from 'electron-log/renderer'
import type { PendingPermission } from '../../stores/permission-store'
import { IpcChannel } from '../../../shared/ipc'
import type { RespondPermissionResponse } from '../../../shared/types'
import { Button } from '@renderer/components/ui/button'
import { usePermissionStore } from '../../stores/permission-store'

interface PermissionCardProps {
  permission: PendingPermission
}

export function PermissionCard({ permission }: PermissionCardProps) {
  const remove = usePermissionStore((s) => s.remove)

  const respond = async (approved: boolean): Promise<void> => {
    try {
      await window.electronAPI.invoke<RespondPermissionResponse>(
        IpcChannel.RESPOND_PERMISSION,
        { requestId: permission.requestId, approved },
      )
    } catch (err) {
      log.error('[PermissionCard] RESPOND_PERMISSION error:', err)
    } finally {
      remove(permission.requestId)
    }
  }

  return (
    <div className="rounded-xl border border-yellow-700/50 bg-yellow-950/40 px-4 py-3 text-sm">
      {/* Header */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-yellow-400" />
          <span className="font-semibold text-yellow-200">도구 실행 승인 요청</span>
        </div>
        {permission.agentId && (
          <span className="rounded bg-muted px-2 py-0.5 font-mono text-xs text-muted-foreground">
            {permission.agentId}
          </span>
        )}
      </div>

      {/* Tool name */}
      <div className="mt-2 font-mono text-blue-300">{permission.toolName}</div>

      {/* Input params */}
      {Object.keys(permission.input).length > 0 && (
        <pre className="mt-2 max-h-40 overflow-auto rounded bg-card p-2 text-xs text-foreground">
          {JSON.stringify(permission.input, null, 2)}
        </pre>
      )}

      {/* Actions */}
      <div className="mt-3 flex gap-2">
        <Button size="sm" variant="default" onClick={() => respond(true)}>
          허용
        </Button>
        <Button size="sm" variant="outline" onClick={() => respond(false)}>
          거부
        </Button>
      </div>
    </div>
  )
}
