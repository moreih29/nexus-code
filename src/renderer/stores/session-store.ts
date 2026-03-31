import { createStore, useStore, type StoreApi } from 'zustand'
import { createContext, useContext } from 'react'
import log from 'electron-log/renderer'

const rlog = log.scope('renderer:session-store')
import type { SessionStatus, ToolCallEvent, LoadHistoryResponse } from '../../shared/types'
import { IpcChannel } from '../../shared/ipc'

export interface RestartSessionOptions {
  cwd: string
  model?: string
  effortLevel?: string
  permissionMode?: string
}

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

/** 단일 세션 상태 (하위 호환성을 위해 export 유지) */
export interface TabState {
  sessionId: string | null
  status: SessionStatus
  messages: Message[]
  systemEvents: SystemEvent[]
  lastTurnStats: TurnStats | null
  streamBuffer: string
  prefillText: string
}

export interface SessionStoreState {
  sessionId: string | null
  status: SessionStatus
  messages: Message[]
  systemEvents: SystemEvent[]
  lastTurnStats: TurnStats | null
  turnHistory: TurnStats[]
  streamBuffer: string
  prefillText: string

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
  addTurnToHistory: (stats: TurnStats) => void
  setPrefillText: (text: string) => void
  endSession: () => void
  restoreSession: (sessionId: string) => Promise<void>
  reset: () => void
  dismissTimeout: () => void
  sendResponse: (text: string) => void
  restartSession: (options: RestartSessionOptions) => Promise<void>
}

// ─── turnHistory 유틸 ───────────────────────────────────────────────────────

function turnHistoryStorageKey(sessionId: string): string {
  return `nexus-turns-${sessionId}`
}

function saveTurnHistory(sessionId: string, history: TurnStats[]): void {
  try {
    localStorage.setItem(turnHistoryStorageKey(sessionId), JSON.stringify(history))
  } catch {
    // localStorage 접근 실패 시 무시
  }
}

function loadTurnHistory(sessionId: string): TurnStats[] {
  try {
    const raw = localStorage.getItem(turnHistoryStorageKey(sessionId))
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as TurnStats[]) : []
  } catch {
    return []
  }
}

function deleteTurnHistory(sessionId: string): void {
  try {
    localStorage.removeItem(turnHistoryStorageKey(sessionId))
  } catch {
    // 무시
  }
}

// ─── 스토어 레지스트리 ────────────────────────────────────────────────────────

/** 워크스페이스 경로 → 스토어 매핑 */
const _workspaceStores = new Map<string, StoreApi<SessionStoreState>>()
/** 세션ID → 스토어 매핑 (IPC 라우팅용) */
const _sessionStores = new Map<string, StoreApi<SessionStoreState>>()
/** 현재 활성 스토어 (비React 코드용) */
let _activeStore: StoreApi<SessionStoreState> | null = null

export function getOrCreateWorkspaceStore(workspacePath: string): StoreApi<SessionStoreState> {
  if (!_workspaceStores.has(workspacePath)) {
    _workspaceStores.set(workspacePath, createSessionStore())
  }
  return _workspaceStores.get(workspacePath)!
}

export function removeWorkspaceStore(workspacePath: string): void {
  const store = _workspaceStores.get(workspacePath)
  if (store) {
    const sessionId = store.getState().sessionId
    if (sessionId) _sessionStores.delete(sessionId)
    _workspaceStores.delete(workspacePath)
  }
}

export function registerSession(sessionId: string, store: StoreApi<SessionStoreState>): void {
  _sessionStores.set(sessionId, store)
}

export function unregisterSession(sessionId: string): void {
  _sessionStores.delete(sessionId)
}

export function getStoreBySessionId(sessionId: string): StoreApi<SessionStoreState> | undefined {
  return _sessionStores.get(sessionId)
}

export function setActiveStore(store: StoreApi<SessionStoreState> | null): void {
  _activeStore = store
}

export function getActiveStore(): StoreApi<SessionStoreState> | null {
  return _activeStore
}

// ─── 스토어 팩토리 ────────────────────────────────────────────────────────────

export function createSessionStore(): StoreApi<SessionStoreState> {
  // 클로저 격리 상태
  let msgCounter = 0
  const nextId = (): string => `msg-${++msgCounter}`
  let evtCounter = 0
  const nextEvtId = (): string => `evt-${++evtCounter}`
  let _textBuffer = ''
  let _rafId: number | null = null
  let _lastFlushTime = 0
  // toolUseId → messages 배열 인덱스 (O(1) resolveToolCall 조회)
  const _toolCallIndex = new Map<string, number>()

  // forward ref: startSession/restoreSession에서 registerSession에 전달
  let storeApi: StoreApi<SessionStoreState>

  const store = createStore<SessionStoreState>()((set, get) => ({
    sessionId: null,
    status: 'idle',
    messages: [],
    systemEvents: [],
    lastTurnStats: null,
    turnHistory: [],
    streamBuffer: '',
    prefillText: '',

    startSession: (sessionId) => {
      registerSession(sessionId, storeApi)
      const existingHistory = loadTurnHistory(sessionId)
      set({
        sessionId,
        status: 'running',
        streamBuffer: '',
        turnHistory: existingHistory,
      })
    },

    setStatus: (status) => set({ status }),

    addUserMessage: (content, checkpointRef?) =>
      set((s) => ({
        messages: [
          ...s.messages,
          { id: nextId(), role: 'user', content, timestamp: Date.now(), checkpointRef },
        ],
      })),

    appendTextChunk: (text) => {
      // 텍스트 버퍼에 즉시 누적
      _textBuffer += text
      rlog.debug('appendTextChunk len=%d bufTotal=%d', text.length, _textBuffer.length)

      // 기존 타이머 취소 후 50ms 디바운스로 messages 갱신
      if (_rafId !== null) {
        cancelAnimationFrame(_rafId)
      }
      _rafId = requestAnimationFrame(() => {
        _rafId = null
        const buffered = _textBuffer
        const now = Date.now()
        rlog.debug('flush', { flushedLen: buffered.length, timeSinceLastFlush: now - _lastFlushTime })
        _lastFlushTime = now
        set((s) => {
          const newBuffer = s.streamBuffer + buffered
          // 버퍼를 소비했으므로 초기화 (다음 청크가 쌓이기 전)
          _textBuffer = ''
          const lastMsg = s.messages[s.messages.length - 1]

          if (lastMsg?.role === 'assistant' && !lastMsg.toolCalls?.length) {
            return {
              streamBuffer: newBuffer,
              messages: s.messages.map((m, i) =>
                i === s.messages.length - 1 ? { ...m, content: newBuffer } : m,
              ),
            }
          } else {
            return {
              streamBuffer: newBuffer,
              messages: [
                ...s.messages,
                { id: nextId(), role: 'assistant', content: newBuffer, timestamp: Date.now() },
              ],
            }
          }
        })
      })
    },

    flushStreamBuffer: () => set({ streamBuffer: '' }),

    addToolCall: (event) => {
      // 디바운스된 청크가 있다면 즉시 flush
      if (_rafId !== null) {
        cancelAnimationFrame(_rafId)
        _rafId = null
        const buffered = _textBuffer
        _textBuffer = ''
        set((s) => {
          if (!buffered) return s
          const newBuffer = s.streamBuffer + buffered
          const lastMsg = s.messages[s.messages.length - 1]
          if (lastMsg?.role === 'assistant' && !lastMsg.toolCalls?.length) {
            return {
              streamBuffer: newBuffer,
              messages: s.messages.map((m, i) =>
                i === s.messages.length - 1 ? { ...m, content: newBuffer } : m,
              ),
            }
          } else {
            return {
              streamBuffer: newBuffer,
              messages: [
                ...s.messages,
                { id: nextId(), role: 'assistant', content: newBuffer, timestamp: Date.now() },
              ],
            }
          }
        })
      }

      set((s) => {
        const lastMsg = s.messages[s.messages.length - 1]
        const toolCall: ToolCallRecord = {
          toolUseId: event.toolUseId,
          name: event.name,
          input: event.input,
        }

        if (lastMsg?.role === 'assistant') {
          const msgIndex = s.messages.length - 1
          _toolCallIndex.set(event.toolUseId, msgIndex)
          return {
            streamBuffer: '',
            messages: s.messages.map((m, i) =>
              i === msgIndex
                ? { ...m, toolCalls: [...(m.toolCalls ?? []), toolCall] }
                : m,
            ),
          }
        } else {
          const msgIndex = s.messages.length
          _toolCallIndex.set(event.toolUseId, msgIndex)
          return {
            streamBuffer: '',
            messages: [
              ...s.messages,
              {
                id: nextId(),
                role: 'assistant',
                content: '',
                toolCalls: [toolCall],
                timestamp: Date.now(),
              },
            ],
          }
        }
      })
    },

    resolveToolCall: (toolUseId, content, isError) =>
      set((s) => {
        const msgIndex = _toolCallIndex.get(toolUseId)
        if (msgIndex === undefined) {
          // fallback: 선형 탐색
          return {
            messages: s.messages.map((m) =>
              m.toolCalls?.some((tc) => tc.toolUseId === toolUseId)
                ? {
                    ...m,
                    toolCalls: m.toolCalls.map((tc) =>
                      tc.toolUseId === toolUseId ? { ...tc, result: content, isError } : tc,
                    ),
                  }
                : m,
            ),
          }
        }
        const messages = s.messages.slice()
        const msg = messages[msgIndex]
        if (!msg?.toolCalls) return s
        messages[msgIndex] = {
          ...msg,
          toolCalls: msg.toolCalls.map((tc) =>
            tc.toolUseId === toolUseId ? { ...tc, result: content, isError } : tc,
          ),
        }
        return { messages }
      }),

    addSystemEvent: (event) =>
      set((s) => ({
        systemEvents: [...s.systemEvents, { ...event, id: nextEvtId() }],
      })),

    removeMessagesAfter: (timestamp) =>
      set((s) => {
        const filteredMessages = s.messages.filter((m) => m.timestamp <= timestamp)
        // toolCallIndex에서 제거된 메시지의 엔트리 삭제
        for (const [toolUseId, idx] of _toolCallIndex) {
          if (idx >= filteredMessages.length) {
            _toolCallIndex.delete(toolUseId)
          }
        }
        return {
          messages: filteredMessages,
          systemEvents: s.systemEvents.filter((e) => e.timestamp <= timestamp),
        }
      }),

    setLastTurnStats: (stats) => set({ lastTurnStats: stats }),

    addTurnToHistory: (stats) =>
      set((s) => {
        const newHistory = [...s.turnHistory, stats]
        if (s.sessionId) {
          saveTurnHistory(s.sessionId, newHistory)
        }
        return { turnHistory: newHistory }
      }),

    setPrefillText: (text) => set({ prefillText: text }),

    endSession: () => set({ status: 'idle', streamBuffer: '' }),

    dismissTimeout: () => set({ status: 'running' }),

    restoreSession: async (sessionId: string) => {
      registerSession(sessionId, storeApi)
      const restoredHistory = loadTurnHistory(sessionId)
      set({ sessionId, status: 'idle', messages: [], streamBuffer: '', turnHistory: restoredHistory })

      try {
        const res = await window.electronAPI.invoke(
          IpcChannel.LOAD_HISTORY,
          { sessionId }
        )
        if (res.ok && res.messages.length > 0) {
          set({
            messages: res.messages.map((m, i) => ({
              id: `history-${i}`,
              role: m.role as 'user' | 'assistant',
              content: m.content,
              toolCalls: m.toolCalls?.map(tc => ({
                ...tc,
                result: tc.result ?? '',
              })),
              timestamp: m.timestamp,
            })),
          })
        }
      } catch (err) {
        rlog.error('restoreSession LOAD_HISTORY failed:', err)
      }
    },

    reset: () => {
      // 디바운스/인덱스 상태 초기화
      _toolCallIndex.clear()
      _textBuffer = ''
      if (_rafId) { cancelAnimationFrame(_rafId); _rafId = null }
      // turnHistory localStorage 삭제 + 세션 레지스트리에서 제거
      const { sessionId } = get()
      if (sessionId) {
        deleteTurnHistory(sessionId)
        unregisterSession(sessionId)
      }
      set({
        sessionId: null,
        status: 'idle',
        messages: [],
        systemEvents: [],
        lastTurnStats: null,
        turnHistory: [],
        streamBuffer: '',
        prefillText: '',
      })
    },

    sendResponse: (text) => {
      const { sessionId } = get()
      if (!sessionId) return
      const { addUserMessage, setStatus } = get()
      addUserMessage(text)
      setStatus('running')
      window.electronAPI.invoke(IpcChannel.PROMPT, { sessionId, message: text }).catch(() => {})
    },

    restartSession: async (options: RestartSessionOptions) => {
      const { sessionId } = get()
      if (!sessionId) return
      set({ status: 'restarting' })
      try {
        const res = await window.electronAPI.invoke(IpcChannel.RESTART_SESSION, {
          sessionId,
          cwd: options.cwd,
          model: options.model,
          effortLevel: options.effortLevel,
          permissionMode: options.permissionMode,
        })
        if (res.ok) {
          set({ status: 'idle' })
        } else {
          set({ status: 'error' })
        }
      } catch {
        set({ status: 'error' })
      }
    },
  }))

  storeApi = store
  return store
}

// ─── React Context + Hook ─────────────────────────────────────────────────────

// 워크스페이스 미선택 시 fallback용 빈 스토어 (idle 상태, 액션은 no-op)
const _emptyStore = createSessionStore()

export const SessionStoreContext = createContext<StoreApi<SessionStoreState> | null>(null)

export function useActiveSession<T>(selector: (state: SessionStoreState) => T): T {
  const store = useContext(SessionStoreContext)
  return useStore(store ?? _emptyStore, selector)
}
