import { create } from 'zustand'
import { IpcChannel } from '@shared/ipc'

export type PermissionPriority = 'high' | 'normal' | 'low'

export interface PendingPermission {
  requestId: string
  toolName: string
  input: Record<string, unknown>
  agentId?: string
  timestamp: number
  priority: PermissionPriority
}

type SortBy = 'timestamp' | 'priority'

interface PermissionState {
  queue: PendingPermission[]
  sortBy: SortBy
  add: (req: PendingPermission) => void
  remove: (requestId: string) => void
  setSortBy: (sortBy: SortBy) => void
  approveAll: () => void
  denyAll: () => void
  approveByAgent: (agentId: string) => void
}

const priorityOrder: Record<PermissionPriority, number> = {
  high: 0,
  normal: 1,
  low: 2,
}

function sortQueue(queue: PendingPermission[], sortBy: SortBy): PendingPermission[] {
  return [...queue].sort((a, b) => {
    if (sortBy === 'priority') {
      return priorityOrder[a.priority] - priorityOrder[b.priority]
    }
    return a.timestamp - b.timestamp
  })
}

export const usePermissionStore = create<PermissionState>((set, get) => ({
  queue: [],
  sortBy: 'timestamp',

  add: (req) =>
    set((s) => {
      if (s.queue.some((r) => r.requestId === req.requestId)) return s
      return { queue: sortQueue([...s.queue, req], s.sortBy) }
    }),

  remove: (requestId) =>
    set((s) => ({ queue: s.queue.filter((r) => r.requestId !== requestId) })),

  setSortBy: (sortBy) =>
    set((s) => ({ sortBy, queue: sortQueue(s.queue, sortBy) })),

  approveAll: () => {
    const { queue } = get()
    queue.forEach((p) => {
      window.electronAPI
        .invoke(IpcChannel.RESPOND_PERMISSION, { requestId: p.requestId, approved: true, scope: 'once' })
        .catch(() => {})
    })
    set({ queue: [] })
  },

  denyAll: () => {
    const { queue } = get()
    queue.forEach((p) => {
      window.electronAPI
        .invoke(IpcChannel.RESPOND_PERMISSION, { requestId: p.requestId, approved: false })
        .catch(() => {})
    })
    set({ queue: [] })
  },

  approveByAgent: (agentId) => {
    const { queue } = get()
    const targets = queue.filter((p) => p.agentId === agentId)
    targets.forEach((p) => {
      window.electronAPI
        .invoke(IpcChannel.RESPOND_PERMISSION, { requestId: p.requestId, approved: true, scope: 'once' })
        .catch(() => {})
    })
    set((s) => ({ queue: s.queue.filter((p) => p.agentId !== agentId) }))
  },
}))
