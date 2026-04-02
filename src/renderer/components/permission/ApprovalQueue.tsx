import { useState, useRef, useEffect } from 'react'
import { CheckCircle, ChevronDown } from 'lucide-react'
import { usePermissionStore } from '../../stores/permission-store'
import type { PendingPermission, PermissionPriority } from '../../stores/permission-store'
import { PermissionCard } from './PermissionCard'
import { Button } from '@renderer/components/ui/button'

function relativeTime(timestamp: number): string {
  const diff = Math.floor((Date.now() - timestamp) / 1000)
  if (diff < 5) return '방금'
  if (diff < 60) return `${diff}초 전`
  const mins = Math.floor(diff / 60)
  if (mins < 60) return `${mins}분 전`
  const hours = Math.floor(mins / 60)
  return `${hours}시간 전`
}

function priorityClass(priority: PermissionPriority): string {
  if (priority === 'high') return 'border-l-2 border-l-destructive'
  if (priority === 'normal') return 'border-l-2 border-l-warning'
  return ''
}

function BulkApproveButton() {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const approveAll = usePermissionStore((s) => s.approveAll)
  const denyAll = usePermissionStore((s) => s.denyAll)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  return (
    <div ref={ref} className="relative flex items-center gap-1">
      <div className="flex">
        <button
          onClick={() => approveAll()}
          className="inline-flex h-7 items-center rounded-l-md bg-primary px-2.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          모두 허용
        </button>
        <button
          onClick={() => setOpen((v) => !v)}
          className="inline-flex h-7 w-6 items-center justify-center rounded-r-md border-l border-primary-foreground/20 bg-primary text-primary-foreground transition-colors hover:bg-primary/90"
          aria-label="일괄 승인 범위 선택"
        >
          <ChevronDown className="h-3 w-3" />
        </button>
      </div>

      <Button size="sm" variant="outline" className="h-7 px-2.5 text-xs" onClick={() => denyAll()}>
        모두 거부
      </Button>

      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 min-w-[140px] rounded-md border border-border bg-popover py-1 shadow-md">
          <button
            className="flex w-full items-center px-3 py-1.5 text-left text-xs text-foreground hover:bg-accent"
            onClick={() => { approveAll(); setOpen(false) }}
          >
            모두 이번만 허용
          </button>
        </div>
      )}
    </div>
  )
}

function PermissionCardWithMeta({ permission }: { permission: PendingPermission }) {
  return (
    <div className={priorityClass(permission.priority)}>
      <PermissionCard permission={permission} />
      <div className="px-4 pb-2 text-xs text-muted-foreground">
        {relativeTime(permission.timestamp)}
      </div>
    </div>
  )
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-10 text-muted-foreground">
      <CheckCircle className="h-8 w-8 opacity-40" />
      <span className="text-sm">승인 대기 없음</span>
    </div>
  )
}

export function ApprovalQueue() {
  const queue = usePermissionStore((s) => s.queue)

  return (
    <div className="flex flex-col">
      {queue.length > 0 && (
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-background px-4 py-2">
          <span className="text-xs text-muted-foreground">
            승인 대기 {queue.length}건
          </span>
          <BulkApproveButton />
        </div>
      )}

      <div className="flex flex-col gap-2 px-4 py-3">
        {queue.length === 0 ? (
          <EmptyState />
        ) : (
          queue.map((p) => <PermissionCardWithMeta key={p.requestId} permission={p} />)
        )}
      </div>
    </div>
  )
}
