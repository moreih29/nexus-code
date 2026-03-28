import { useState, useRef, useEffect } from 'react'
import log from 'electron-log/renderer'
import type { PendingPermission } from '../../stores/permission-store'
import { IpcChannel } from '../../../shared/ipc'
import type { ApprovalScope, RespondPermissionResponse } from '../../../shared/types'
import { Button } from '@renderer/components/ui/button'
import { usePermissionStore } from '../../stores/permission-store'
import { DiffView } from '../shared/DiffView'
import { ChevronDown } from 'lucide-react'

function str(v: unknown): string {
  if (typeof v === 'string') return v
  if (v === null || v === undefined) return ''
  return JSON.stringify(v)
}

function PermissionInputView({
  toolName,
  input,
}: {
  toolName: string
  input: Record<string, unknown>
}) {
  if (toolName === 'Edit' || toolName === 'MultiEdit') {
    const filePath = str(input.file_path)
    const oldString = str(input.old_string)
    const newString = str(input.new_string)
    return (
      <div className="mt-2">
        {filePath && (
          <div className="mb-1 font-mono text-xs text-muted-foreground">{filePath}</div>
        )}
        <DiffView oldString={oldString} newString={newString} maxLines={50} />
      </div>
    )
  }

  if (toolName === 'Write') {
    const filePath = str(input.file_path)
    const content = str(input.content)
    const lines = content.split('\n')
    const preview = lines.slice(0, 50).join('\n')
    const truncated = lines.length > 50
    return (
      <div className="mt-2">
        {filePath && (
          <div className="mb-1 font-mono text-xs text-muted-foreground">
            {filePath}
            <span className="ml-2 text-yellow-400">파일 생성/덮어쓰기</span>
          </div>
        )}
        <pre className="max-h-60 overflow-auto rounded border border-border bg-card p-2 font-mono text-xs text-foreground whitespace-pre-wrap break-all">
          {preview}
          {truncated && <span className="text-muted-foreground">{'\n'}…</span>}
        </pre>
      </div>
    )
  }

  if (toolName === 'Bash') {
    const command = str(input.command)
    return (
      <div className="mt-2">
        <pre className="overflow-auto rounded border border-border bg-card p-2 font-mono text-xs text-foreground whitespace-pre-wrap break-all">
          {command}
        </pre>
      </div>
    )
  }

  if (Object.keys(input).length > 0) {
    return (
      <pre className="mt-2 max-h-40 overflow-auto rounded bg-card p-2 text-xs text-foreground">
        {JSON.stringify(input, null, 2)}
      </pre>
    )
  }

  return null
}

interface SplitApproveButtonProps {
  onApprove: (scope: ApprovalScope) => void
}

function SplitApproveButton({ onApprove }: SplitApproveButtonProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  return (
    <div ref={ref} className="relative flex">
      <button
        onClick={() => onApprove('once')}
        className="inline-flex h-9 items-center rounded-l-md bg-primary px-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        허용
      </button>
      <button
        onClick={() => setOpen((v) => !v)}
        className="inline-flex h-9 w-8 items-center justify-center rounded-r-md border-l border-primary-foreground/20 bg-primary text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label="승인 범위 선택"
      >
        <ChevronDown className="h-3.5 w-3.5" />
      </button>

      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 min-w-[160px] rounded-md border border-border bg-popover py-1 shadow-md">
          <button
            className="flex w-full items-center px-3 py-1.5 text-left text-sm text-foreground hover:bg-accent"
            onClick={() => { onApprove('once'); setOpen(false) }}
          >
            이번만 허용
          </button>
          <button
            className="flex w-full items-center px-3 py-1.5 text-left text-sm text-foreground hover:bg-accent"
            onClick={() => { onApprove('session'); setOpen(false) }}
          >
            세션 동안 허용
          </button>
          <button
            className="flex w-full items-center px-3 py-1.5 text-left text-sm text-foreground hover:bg-accent"
            onClick={() => { onApprove('permanent'); setOpen(false) }}
          >
            항상 허용
          </button>
        </div>
      )}
    </div>
  )
}

interface PermissionCardProps {
  permission: PendingPermission
}

export function PermissionCard({ permission }: PermissionCardProps) {
  const remove = usePermissionStore((s) => s.remove)

  const respond = async (approved: boolean, scope?: ApprovalScope): Promise<void> => {
    try {
      await window.electronAPI.invoke<RespondPermissionResponse>(
        IpcChannel.RESPOND_PERMISSION,
        { requestId: permission.requestId, approved, scope },
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
      <PermissionInputView toolName={permission.toolName} input={permission.input} />

      {/* Actions */}
      <div className="mt-3 flex items-center gap-2">
        <SplitApproveButton onApprove={(scope) => respond(true, scope)} />
        <Button size="sm" variant="outline" onClick={() => remove(permission.requestId)}>
          닫기
        </Button>
        <span className="ml-auto text-[11px] text-yellow-600">관찰 전용 — 도구 실행은 차단되지 않습니다</span>
      </div>
    </div>
  )
}
