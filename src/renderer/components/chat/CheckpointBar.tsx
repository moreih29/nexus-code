import { useCheckpointStore } from '../../stores/checkpoint-store'
import { useWorkspaceStore } from '../../stores/workspace-store'
import { useSessionStore } from '../../stores/session-store'

export function CheckpointBar() {
  const { checkpoints, isGitRepo, isRestoring, restoreCheckpoint } = useCheckpointStore()
  const activeWorkspace = useWorkspaceStore((s) => s.activeWorkspace)
  const { addSystemEvent, removeMessagesAfter } = useSessionStore()

  if (!isGitRepo || checkpoints.length === 0 || !activeWorkspace) return null

  const latest = checkpoints[0]

  const timeLabel = new Date(latest.timestamp).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })

  const handleRestore = async (): Promise<void> => {
    const confirmed = window.confirm(
      `현재 변경사항을 버리고 ${timeLabel} 시점으로 되돌리시겠습니까?`
    )
    if (!confirmed) return
    const { ok, changedFiles, shortHash } = await restoreCheckpoint(activeWorkspace, latest)
    if (ok) {
      removeMessagesAfter(latest.timestamp)
      const fileCount = changedFiles.length
      const label = fileCount > 0
        ? `${shortHash} · ${timeLabel} 시점으로 복원 (${fileCount}개 파일)`
        : `${shortHash} · ${timeLabel} 시점으로 복원`
      addSystemEvent({
        type: 'checkpoint_restore',
        timestamp: latest.timestamp + 1,
        label,
      })
    }
  }

  return (
    <div className="mx-4 mb-2 flex items-center justify-between rounded-lg border border-border bg-muted/30 px-3 py-2">
      <span className="text-xs text-muted-foreground">
        체크포인트: {timeLabel}
      </span>
      <button
        onClick={handleRestore}
        disabled={isRestoring}
        className="rounded px-2 py-1 text-xs text-foreground hover:bg-accent disabled:opacity-50"
      >
        {isRestoring ? '복원 중...' : '되돌리기'}
      </button>
    </div>
  )
}
