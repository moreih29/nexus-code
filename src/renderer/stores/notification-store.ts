import { create } from 'zustand'

interface NotificationState {
  /** 워크스페이스 경로 → 미확인 메시지 수 */
  unreadCounts: Map<string, number>
  /** 세션 soft limit 경고를 이미 표시했는지 */
  sessionLimitWarned: boolean

  incrementUnread: (workspacePath: string) => void
  resetUnread: (workspacePath: string) => void
  getUnreadCount: (workspacePath: string) => number
  setSessionLimitWarned: (warned: boolean) => void
}

export const useNotificationStore = create<NotificationState>((set, get) => ({
  unreadCounts: new Map(),
  sessionLimitWarned: false,

  incrementUnread: (workspacePath) => {
    const counts = new Map(get().unreadCounts)
    counts.set(workspacePath, (counts.get(workspacePath) ?? 0) + 1)
    set({ unreadCounts: counts })
  },

  resetUnread: (workspacePath) => {
    const counts = new Map(get().unreadCounts)
    counts.delete(workspacePath)
    set({ unreadCounts: counts })
  },

  getUnreadCount: (workspacePath) => {
    return get().unreadCounts.get(workspacePath) ?? 0
  },

  setSessionLimitWarned: (warned) => set({ sessionLimitWarned: warned }),
}))
