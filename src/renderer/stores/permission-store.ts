import { create } from 'zustand'

export interface PendingPermission {
  requestId: string
  toolName: string
  input: Record<string, unknown>
  agentId?: string
  timestamp: number
}

interface PermissionState {
  queue: PendingPermission[]
  add: (req: PendingPermission) => void
  remove: (requestId: string) => void
}

export const usePermissionStore = create<PermissionState>((set) => ({
  queue: [],

  add: (req) =>
    set((s) => ({
      queue: s.queue.some((r) => r.requestId === req.requestId)
        ? s.queue
        : [...s.queue, req],
    })),

  remove: (requestId) =>
    set((s) => ({ queue: s.queue.filter((r) => r.requestId !== requestId) })),
}))
