import { create } from 'zustand'
import log from 'electron-log/renderer'
import type { Checkpoint, CheckpointCreateResponse, CheckpointRestoreResponse, CheckpointListResponse } from '../../shared/types'
import { IpcChannel } from '../../shared/ipc'

interface CheckpointState {
  checkpoints: Checkpoint[]
  isGitRepo: boolean
  isRestoring: boolean

  // Actions
  setCheckpoint: (checkpoint: Checkpoint) => void
  createCheckpoint: (cwd: string, sessionId: string) => Promise<Checkpoint | null>
  restoreCheckpoint: (cwd: string, checkpoint: Checkpoint) => Promise<{ ok: boolean; changedFiles: string[]; shortHash: string }>
  listCheckpoints: (cwd: string, sessionId?: string) => Promise<void>
  reset: () => void
}

export const useCheckpointStore = create<CheckpointState>((set) => ({
  checkpoints: [],
  isGitRepo: false,
  isRestoring: false,

  setCheckpoint: (checkpoint) => {
    set((s) => ({ checkpoints: [checkpoint, ...s.checkpoints], isGitRepo: true }))
  },

  createCheckpoint: async (cwd, sessionId) => {
    try {
      const res = await window.electronAPI.invoke<CheckpointCreateResponse>(
        IpcChannel.CHECKPOINT_CREATE,
        { cwd, sessionId }
      )
      set({ isGitRepo: res.isGitRepo })
      if (res.ok && res.checkpoint) {
        set((s) => ({ checkpoints: [res.checkpoint!, ...s.checkpoints] }))
        return res.checkpoint
      }
    } catch (err) {
      log.error('[CheckpointStore] createCheckpoint 실패:', err)
    }
    return null
  },

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
      return { ok: true, changedFiles: res.changedFiles ?? [], shortHash: res.shortHash ?? '' }
    } catch (err) {
      log.error('[CheckpointStore] restoreCheckpoint 오류:', err)
      return { ok: false, changedFiles: [], shortHash: '' }
    } finally {
      set({ isRestoring: false })
    }
  },

  listCheckpoints: async (cwd, sessionId) => {
    try {
      const res = await window.electronAPI.invoke<CheckpointListResponse>(
        IpcChannel.CHECKPOINT_LIST,
        { cwd, sessionId }
      )
      if (res.ok) {
        set({ checkpoints: res.checkpoints, isGitRepo: true })
      }
    } catch (err) {
      log.error('[CheckpointStore] listCheckpoints 실패:', err)
    }
  },

  reset: () => set({ checkpoints: [], isGitRepo: false, isRestoring: false }),
}))
