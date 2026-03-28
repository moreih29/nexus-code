import { create } from 'zustand'
import log from 'electron-log/renderer'
import type { SessionStatus, ToolCallEvent, LoadHistoryResponse } from '../../shared/types'
import { IpcChannel } from '../../shared/ipc'

export interface TurnStats {
  costUsd?: number
  inputTokens?: number
  outputTokens?: number
  durationApiMs?: number
  numTurns?: number
}

export interface ToolCallRecord {
  toolUseId: string
  name: string
  input: Record<string, unknown>
  result?: string
  isError?: boolean
}

export interface SystemEvent {
  id: string
  type: 'checkpoint_restore'
  timestamp: number
  label: string
}

export interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  toolCalls?: ToolCallRecord[]
  timestamp: number
  /** 프롬프트 전송 직전 git stash create로 생성한 hash. user 메시지에만 설정 */
  checkpointRef?: string
}

export interface TabState {
  sessionId: string | null
  status: SessionStatus
  messages: Message[]
  systemEvents: SystemEvent[]
  lastTurnStats: TurnStats | null
  /** Accumulates streamed text for the current assistant turn */
  streamBuffer: string
  /** 체크포인트 복원 후 입력창에 미리 채울 텍스트 */
  prefillText: string
}

/** 동시 실행 프로세스 상한 */
export const MAX_CONCURRENT_SESSIONS = 5

/** 비활성 탭 메시지 트리밍 임계값 */
export const INACTIVE_TAB_MESSAGE_LIMIT = 100

interface SessionStoreState {
  tabs: Record<string, TabState>
  tabOrder: string[]
  activeTabId: string | null
  /** sessionId → tabId 매핑 (O(1) 라우팅용) */
  sessionTabMap: Record<string, string>

  // 탭 관리 액션
  addTab: () => string
  closeTab: (tabId: string) => void
  switchTab: (tabId: string) => void
  /** 현재 running 상태인 탭 개수 */
  getRunningCount: () => number
  /** 새 탭 추가 가능 여부 (프로세스 풀 상한 미달) */
  canAddTab: () => boolean

  // 기존 액션들 — 모두 activeTabId의 TabState를 대상으로 동작
  startSession: (sessionId: string) => void
  setStatus: (status: SessionStatus) => void
  addUserMessage: (content: string, checkpointRef?: string) => void
  appendTextChunk: (text: string) => void
  flushStreamBuffer: () => void
  addToolCall: (event: ToolCallEvent) => void
  resolveToolCall: (toolUseId: string, content: string, isError?: boolean) => void
  addSystemEvent: (event: Omit<SystemEvent, 'id'>) => void
  removeMessagesAfter: (timestamp: number) => void
  setLastTurnStats: (stats: TurnStats) => void
  setPrefillText: (text: string) => void
  endSession: () => void
  restoreSession: (sessionId: string) => Promise<void>
  reset: () => void
  dismissTimeout: () => void
  sendResponse: (text: string) => void

  // 특정 탭을 대상으로 하는 내부 액션 (ipc-bridge 라우팅용)
  appendTextChunkToTab: (tabId: string, text: string) => void
  addToolCallToTab: (tabId: string, event: ToolCallEvent) => void
  resolveToolCallInTab: (tabId: string, toolUseId: string, content: string, isError?: boolean) => void
  flushStreamBufferInTab: (tabId: string) => void
  setLastTurnStatsInTab: (tabId: string, stats: TurnStats) => void
  endSessionInTab: (tabId: string) => void
  setStatusInTab: (tabId: string, status: SessionStatus) => void
}

let msgCounter = 0
const nextId = (): string => `msg-${++msgCounter}`
let evtCounter = 0
const nextEvtId = (): string => `evt-${++evtCounter}`
let tabCounter = 0
const nextTabId = (): string => `tab-${++tabCounter}`

const createDefaultTab = (): TabState => ({
  sessionId: null,
  status: 'idle',
  messages: [],
  systemEvents: [],
  lastTurnStats: null,
  streamBuffer: '',
  prefillText: '',
})

/** activeTabId의 TabState를 업데이트하는 헬퍼 */
function updateActiveTab(
  state: SessionStoreState,
  updater: (tab: TabState) => Partial<TabState>,
): Partial<SessionStoreState> {
  const { activeTabId, tabs } = state
  if (!activeTabId) return {}
  const tab = tabs[activeTabId]
  if (!tab) return {}
  return {
    tabs: {
      ...tabs,
      [activeTabId]: { ...tab, ...updater(tab) },
    },
  }
}

/** 특정 tabId의 TabState를 업데이트하는 헬퍼 */
function updateTab(
  state: SessionStoreState,
  tabId: string,
  updater: (tab: TabState) => Partial<TabState>,
): Partial<SessionStoreState> {
  const { tabs } = state
  const tab = tabs[tabId]
  if (!tab) return {}
  return {
    tabs: {
      ...tabs,
      [tabId]: { ...tab, ...updater(tab) },
    },
  }
}

const initialTabId = nextTabId()

export const useSessionStore = create<SessionStoreState>((set, get) => ({
  tabs: { [initialTabId]: createDefaultTab() },
  tabOrder: [initialTabId],
  activeTabId: initialTabId,
  sessionTabMap: {},

  getRunningCount: () => {
    const { tabs } = get()
    return Object.values(tabs).filter((t) => t.status === 'running' || t.status === 'restarting').length
  },

  canAddTab: () => {
    const { tabOrder, getRunningCount } = get()
    return tabOrder.length < MAX_CONCURRENT_SESSIONS && getRunningCount() < MAX_CONCURRENT_SESSIONS
  },

  addTab: () => {
    const tabId = nextTabId()
    set((s) => ({
      tabs: { ...s.tabs, [tabId]: createDefaultTab() },
      tabOrder: [...s.tabOrder, tabId],
      activeTabId: tabId,
    }))
    return tabId
  },

  closeTab: (tabId) => {
    set((s) => {
      const newTabs = { ...s.tabs }
      delete newTabs[tabId]
      const newOrder = s.tabOrder.filter((id) => id !== tabId)

      // 닫힌 탭의 sessionId를 sessionTabMap에서 제거
      const closedTab = s.tabs[tabId]
      const newSessionTabMap = { ...s.sessionTabMap }
      if (closedTab?.sessionId) {
        delete newSessionTabMap[closedTab.sessionId]
      }

      // 탭이 하나도 없으면 새 탭 생성
      if (newOrder.length === 0) {
        const newTabId = nextTabId()
        newTabs[newTabId] = createDefaultTab()
        newOrder.push(newTabId)
        return {
          tabs: newTabs,
          tabOrder: newOrder,
          activeTabId: newTabId,
          sessionTabMap: newSessionTabMap,
        }
      }

      // 활성 탭이 닫힌 경우: 이전 탭으로 이동
      let newActiveTabId = s.activeTabId
      if (s.activeTabId === tabId) {
        const closedIndex = s.tabOrder.indexOf(tabId)
        newActiveTabId = newOrder[Math.min(closedIndex, newOrder.length - 1)]
      }

      return {
        tabs: newTabs,
        tabOrder: newOrder,
        activeTabId: newActiveTabId,
        sessionTabMap: newSessionTabMap,
      }
    })
  },

  switchTab: (tabId) => {
    set((s) => {
      if (!s.tabs[tabId]) return {}
      return { activeTabId: tabId }
    })
  },

  startSession: (sessionId) => {
    set((s) => {
      const { activeTabId, tabs } = s
      if (!activeTabId) return {}
      const tab = tabs[activeTabId]
      if (!tab) return {}

      // 이전 sessionId를 sessionTabMap에서 제거
      const newSessionTabMap = { ...s.sessionTabMap }
      if (tab.sessionId) {
        delete newSessionTabMap[tab.sessionId]
      }
      newSessionTabMap[sessionId] = activeTabId

      return {
        tabs: {
          ...tabs,
          [activeTabId]: { ...tab, sessionId, status: 'running', streamBuffer: '' },
        },
        sessionTabMap: newSessionTabMap,
      }
    })
  },

  setStatus: (status) => set((s) => updateActiveTab(s, () => ({ status }))),

  addUserMessage: (content, checkpointRef?) =>
    set((s) =>
      updateActiveTab(s, (tab) => ({
        messages: [
          ...tab.messages,
          { id: nextId(), role: 'user', content, timestamp: Date.now(), checkpointRef },
        ],
      })),
    ),

  appendTextChunk: (text) => {
    const { activeTabId } = get()
    if (!activeTabId) return
    set((s) => {
      const tab = s.tabs[activeTabId]
      if (!tab) return {}
      const newBuffer = tab.streamBuffer + text
      const lastMsg = tab.messages[tab.messages.length - 1]

      if (lastMsg?.role === 'assistant' && !lastMsg.toolCalls?.length) {
        return {
          tabs: {
            ...s.tabs,
            [activeTabId]: {
              ...tab,
              streamBuffer: newBuffer,
              messages: tab.messages.map((m, i) =>
                i === tab.messages.length - 1 ? { ...m, content: newBuffer } : m,
              ),
            },
          },
        }
      } else {
        return {
          tabs: {
            ...s.tabs,
            [activeTabId]: {
              ...tab,
              streamBuffer: newBuffer,
              messages: [
                ...tab.messages,
                { id: nextId(), role: 'assistant', content: newBuffer, timestamp: Date.now() },
              ],
            },
          },
        }
      }
    })
  },

  flushStreamBuffer: () => set((s) => updateActiveTab(s, () => ({ streamBuffer: '' }))),

  addToolCall: (event) => {
    const { activeTabId } = get()
    if (!activeTabId) return
    set((s) => {
      const tab = s.tabs[activeTabId]
      if (!tab) return {}
      const lastMsg = tab.messages[tab.messages.length - 1]
      const toolCall: ToolCallRecord = {
        toolUseId: event.toolUseId,
        name: event.name,
        input: event.input,
      }

      if (lastMsg?.role === 'assistant') {
        return {
          tabs: {
            ...s.tabs,
            [activeTabId]: {
              ...tab,
              streamBuffer: '',
              messages: tab.messages.map((m, i) =>
                i === tab.messages.length - 1
                  ? { ...m, toolCalls: [...(m.toolCalls ?? []), toolCall] }
                  : m,
              ),
            },
          },
        }
      } else {
        return {
          tabs: {
            ...s.tabs,
            [activeTabId]: {
              ...tab,
              streamBuffer: '',
              messages: [
                ...tab.messages,
                {
                  id: nextId(),
                  role: 'assistant',
                  content: '',
                  toolCalls: [toolCall],
                  timestamp: Date.now(),
                },
              ],
            },
          },
        }
      }
    })
  },

  resolveToolCall: (toolUseId, content, isError) =>
    set((s) =>
      updateActiveTab(s, (tab) => ({
        messages: tab.messages.map((m) =>
          m.toolCalls?.some((tc) => tc.toolUseId === toolUseId)
            ? {
                ...m,
                toolCalls: m.toolCalls.map((tc) =>
                  tc.toolUseId === toolUseId ? { ...tc, result: content, isError } : tc,
                ),
              }
            : m,
        ),
      })),
    ),

  addSystemEvent: (event) =>
    set((s) =>
      updateActiveTab(s, (tab) => ({
        systemEvents: [...tab.systemEvents, { ...event, id: nextEvtId() }],
      })),
    ),

  removeMessagesAfter: (timestamp) =>
    set((s) =>
      updateActiveTab(s, (tab) => ({
        messages: tab.messages.filter((m) => m.timestamp <= timestamp),
        systemEvents: tab.systemEvents.filter((e) => e.timestamp <= timestamp),
      })),
    ),

  setLastTurnStats: (stats) => set((s) => updateActiveTab(s, () => ({ lastTurnStats: stats }))),

  setPrefillText: (text) => set((s) => updateActiveTab(s, () => ({ prefillText: text }))),

  endSession: () =>
    set((s) => updateActiveTab(s, () => ({ status: 'idle', streamBuffer: '' }))),

  dismissTimeout: () => set((s) => updateActiveTab(s, () => ({ status: 'running' }))),

  restoreSession: async (sessionId: string) => {
    set((s) => {
      const { activeTabId, tabs } = s
      if (!activeTabId) return {}
      const tab = tabs[activeTabId]
      if (!tab) return {}

      const newSessionTabMap = { ...s.sessionTabMap }
      if (tab.sessionId) {
        delete newSessionTabMap[tab.sessionId]
      }
      newSessionTabMap[sessionId] = activeTabId

      return {
        tabs: {
          ...tabs,
          [activeTabId]: { ...tab, sessionId, status: 'idle', messages: [], streamBuffer: '' },
        },
        sessionTabMap: newSessionTabMap,
      }
    })

    try {
      const res = await window.electronAPI.invoke<LoadHistoryResponse>(
        IpcChannel.LOAD_HISTORY,
        { sessionId }
      )
      if (res.ok && res.messages.length > 0) {
        set((s) =>
          updateActiveTab(s, () => ({
            messages: res.messages.map((m, i) => ({
              id: `history-${i}`,
              role: m.role as 'user' | 'assistant',
              content: m.content,
              toolCalls: m.toolCalls,
              timestamp: m.timestamp,
            })),
          })),
        )
      }
    } catch (err) {
      log.error('[restoreSession] LOAD_HISTORY failed:', err)
    }
  },

  reset: () =>
    set((s) => {
      const { activeTabId, tabs } = s
      if (!activeTabId) return {}
      const tab = tabs[activeTabId]
      if (!tab) return {}

      const newSessionTabMap = { ...s.sessionTabMap }
      if (tab.sessionId) {
        delete newSessionTabMap[tab.sessionId]
      }

      return {
        tabs: {
          ...tabs,
          [activeTabId]: createDefaultTab(),
        },
        sessionTabMap: newSessionTabMap,
      }
    }),

  sendResponse: (text) => {
    const { activeTabId, tabs } = get()
    if (!activeTabId) return
    const tab = tabs[activeTabId]
    if (!tab?.sessionId) return
    const { sessionId } = tab
    const { addUserMessage, setStatus } = get()
    addUserMessage(text)
    setStatus('running')
    window.electronAPI.invoke(IpcChannel.PROMPT, { sessionId, message: text }).catch(() => {})
  },

  // 탭별 라우팅 액션 (ipc-bridge 전용)
  appendTextChunkToTab: (tabId, text) => {
    set((s) => {
      const tab = s.tabs[tabId]
      if (!tab) return {}
      const newBuffer = tab.streamBuffer + text
      const lastMsg = tab.messages[tab.messages.length - 1]

      if (lastMsg?.role === 'assistant' && !lastMsg.toolCalls?.length) {
        return {
          tabs: {
            ...s.tabs,
            [tabId]: {
              ...tab,
              streamBuffer: newBuffer,
              messages: tab.messages.map((m, i) =>
                i === tab.messages.length - 1 ? { ...m, content: newBuffer } : m,
              ),
            },
          },
        }
      } else {
        return {
          tabs: {
            ...s.tabs,
            [tabId]: {
              ...tab,
              streamBuffer: newBuffer,
              messages: [
                ...tab.messages,
                { id: nextId(), role: 'assistant', content: newBuffer, timestamp: Date.now() },
              ],
            },
          },
        }
      }
    })
  },

  addToolCallToTab: (tabId, event) => {
    set((s) => {
      const tab = s.tabs[tabId]
      if (!tab) return {}
      const lastMsg = tab.messages[tab.messages.length - 1]
      const toolCall: ToolCallRecord = {
        toolUseId: event.toolUseId,
        name: event.name,
        input: event.input,
      }

      if (lastMsg?.role === 'assistant') {
        return {
          tabs: {
            ...s.tabs,
            [tabId]: {
              ...tab,
              streamBuffer: '',
              messages: tab.messages.map((m, i) =>
                i === tab.messages.length - 1
                  ? { ...m, toolCalls: [...(m.toolCalls ?? []), toolCall] }
                  : m,
              ),
            },
          },
        }
      } else {
        return {
          tabs: {
            ...s.tabs,
            [tabId]: {
              ...tab,
              streamBuffer: '',
              messages: [
                ...tab.messages,
                {
                  id: nextId(),
                  role: 'assistant',
                  content: '',
                  toolCalls: [toolCall],
                  timestamp: Date.now(),
                },
              ],
            },
          },
        }
      }
    })
  },

  resolveToolCallInTab: (tabId, toolUseId, content, isError) =>
    set((s) =>
      updateTab(s, tabId, (tab) => ({
        messages: tab.messages.map((m) =>
          m.toolCalls?.some((tc) => tc.toolUseId === toolUseId)
            ? {
                ...m,
                toolCalls: m.toolCalls.map((tc) =>
                  tc.toolUseId === toolUseId ? { ...tc, result: content, isError } : tc,
                ),
              }
            : m,
        ),
      })),
    ),

  flushStreamBufferInTab: (tabId) =>
    set((s) => updateTab(s, tabId, () => ({ streamBuffer: '' }))),

  setLastTurnStatsInTab: (tabId, stats) =>
    set((s) => updateTab(s, tabId, () => ({ lastTurnStats: stats }))),

  endSessionInTab: (tabId) =>
    set((s) => {
      const { activeTabId } = s
      // 비활성 탭이고 메시지가 임계값을 초과하면 오래된 메시지 트리밍
      const shouldTrim = tabId !== activeTabId
      return updateTab(s, tabId, (tab) => {
        const messages =
          shouldTrim && tab.messages.length > INACTIVE_TAB_MESSAGE_LIMIT
            ? tab.messages.slice(-INACTIVE_TAB_MESSAGE_LIMIT)
            : tab.messages
        return { status: 'idle', streamBuffer: '', messages }
      })
    }),

  setStatusInTab: (tabId, status) =>
    set((s) => updateTab(s, tabId, () => ({ status }))),
}))
