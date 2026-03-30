import { useState } from 'react'
import { useChangesStore } from '../../stores/changes-store'
import type { FileChange } from '../../stores/changes-store'
import { DiffView } from '../shared/DiffView'
import { ChevronRight, FileCode } from 'lucide-react'
import { cn } from '../../lib/utils'
import { EmptyState } from '../ui/empty-state'

function ChangeEntry({ change }: { change: FileChange }) {
  const [open, setOpen] = useState(false)

  const hasDiff = change.oldString !== undefined || change.newString !== undefined
  const hasContent = change.content !== undefined

  return (
    <div className="border-b border-border last:border-0">
      <button
        className="flex w-full items-center gap-1.5 px-3 py-2 text-left hover:bg-accent/50"
        onClick={() => setOpen((v) => !v)}
      >
        <ChevronRight
          className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')}
        />
        <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
          {change.toolName}
        </span>
        <span className="truncate font-mono text-xs text-foreground">
          {new Date(change.timestamp).toLocaleTimeString()}
        </span>
      </button>

      {open && (
        <div className="px-3 pb-2">
          {hasDiff && (
            <DiffView
              oldString={change.oldString ?? ''}
              newString={change.newString ?? ''}
              maxLines={20}
            />
          )}
          {hasContent && !hasDiff && (
            <pre className="max-h-48 overflow-auto rounded border border-border bg-card p-2 font-mono text-xs text-foreground whitespace-pre-wrap break-all">
              {(change.content ?? '').split('\n').slice(0, 20).join('\n')}
              {(change.content ?? '').split('\n').length > 20 && (
                <span className="text-muted-foreground">{'\n'}…</span>
              )}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}

function FileGroup({ filePath, changes }: { filePath: string; changes: FileChange[] }) {
  const [open, setOpen] = useState(true)

  return (
    <div className="border-b border-border last:border-0">
      <button
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-accent/50"
        onClick={() => setOpen((v) => !v)}
      >
        <ChevronRight
          className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')}
        />
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">{filePath}</span>
        <span className="shrink-0 rounded-full bg-primary/20 px-1.5 py-0.5 text-xs text-primary">
          {changes.length}
        </span>
      </button>

      {open && (
        <div className="ml-4 border-l border-border">
          {changes.map((c) => (
            <ChangeEntry key={c.toolUseId} change={c} />
          ))}
        </div>
      )}
    </div>
  )
}

export function ChangesPanel() {
  const changes = useChangesStore((s) => s.changes)
  const clear = useChangesStore((s) => s.clear)

  if (changes.length === 0) {
    return (
      <EmptyState
        size="sm"
        icon={<FileCode className="h-full w-full" />}
        title="변경된 파일 없음"
      />
    )
  }

  // filePath별 그룹핑
  const grouped = new Map<string, FileChange[]>()
  for (const change of changes) {
    const key = change.filePath || '(알 수 없음)'
    const group = grouped.get(key) ?? []
    group.push(change)
    grouped.set(key, group)
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 text-xs text-muted-foreground">
        <span>{grouped.size}개 파일 변경됨</span>
        <button
          onClick={clear}
          className="hover:text-foreground"
        >
          초기화
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {[...grouped.entries()].map(([filePath, fileChanges]) => (
          <FileGroup key={filePath} filePath={filePath} changes={fileChanges} />
        ))}
      </div>
    </div>
  )
}
