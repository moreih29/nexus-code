import { create } from 'zustand'
import log from 'electron-log/renderer'
import type { Checkpoint, CheckpointRestoreResponse } from '../../shared/types'
import { IpcChannel } from '../../shared/ipc'
import { getActiveStore } from './session-store'

interface CheckpointState {
  isGitRepo: boolean
  isRestoring: boolean

  // Actions
  restoreCheckpoint: (
    cwd: string,
    checkpoint: Checkpoint
  ) => Promise<{ ok: boolean; changedFiles: string[]; shortHash: string }>
  reset: () => void
}

export const useCheckpointStore = create<CheckpointState>((set) => ({
  isGitRepo: false,
  isRestoring: false,

  restoreCheckpoint: async (cwd, checkpoint) => {
    set({ isRestoring: true })
    try {
      const res = await window.electronAPI.invoke<CheckpointRestoreResponse>(
        IpcChannel.CHECKPOINT_RESTORE,
        { cwd, checkpoint }
      )
      if (!res.ok) {
        log.error('[CheckpointStore] restoreCheckpoint 실패:', res.error)
        return { ok: false, changedFiles: [], shortHash: '' }
      }

      const changedFiles = res.changedFiles ?? []
      const shortHash = res.shortHash ?? ''

      // 입력창 프리필 세팅
      const timeLabel = new Date(checkpoint.timestamp).toLocaleTimeString('ko-KR', {
        hour: '2-digit',
        minute: '2-digit',
      })
      const fileList = changedFiles.length > 0
        ? changedFiles.map((f) => f.split('/').pop() ?? f).join(', ')
        : '없음'
      const prefill = `[체크포인트 ${shortHash} (${timeLabel})로 코드 복원됨. 변경 파일: ${fileList}]`
      const store = getActiveStore()
      if (store) {
        store.getState().setPrefillText(prefill)
      }

      return { ok: true, changedFiles, shortHash }
    } catch (err) {
      log.error('[CheckpointStore] restoreCheckpoint 오류:', err)
      return { ok: false, changedFiles: [], shortHash: '' }
    } finally {
      set({ isRestoring: false })
    }
  },

  reset: () => set({ isGitRepo: false, isRestoring: false }),
}))
