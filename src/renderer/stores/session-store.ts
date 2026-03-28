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
}

interface SessionState {
  sessionId: string | null
  status: SessionStatus
  messages: Message[]
  systemEvents: SystemEvent[]
  lastTurnStats: TurnStats | null
  /** Accumulates streamed text for the current assistant turn */
  streamBuffer: string

  // Actions
  startSession: (sessionId: string) => void
  setStatus: (status: SessionStatus) => void
  addUserMessage: (content: string) => void
  appendTextChunk: (text: string) => void
  flushStreamBuffer: () => void
  addToolCall: (event: ToolCallEvent) => void
  resolveToolCall: (toolUseId: string, content: string, isError?: boolean) => void
  addSystemEvent: (event: Omit<SystemEvent, 'id'>) => void
  setLastTurnStats: (stats: TurnStats) => void
  endSession: () => void
  restoreSession: (sessionId: string) => Promise<void>
  reset: () => void
  /** 타임아웃 상태에서 계속 대기 (타이머는 RunManager가 자동 재시작) */
  dismissTimeout: () => void
  /** AskUserQuestion 응답 전송 */
  sendResponse: (text: string) => void
}

let msgCounter = 0
const nextId = (): string => `msg-${++msgCounter}`
let evtCounter = 0
const nextEvtId = (): string => `evt-${++evtCounter}`

export const useSessionStore = create<SessionState>((set, get) => ({
  sessionId: null,
  status: 'idle',
  messages: [],
  systemEvents: [],
  lastTurnStats: null,
  streamBuffer: '',

  startSession: (sessionId) =>
    set((s) => ({ sessionId, status: 'running', messages: s.messages, streamBuffer: '' })),

  setStatus: (status) => set({ status }),

  addUserMessage: (content) =>
    set((s) => ({
      messages: [
        ...s.messages,
        { id: nextId(), role: 'user', content, timestamp: Date.now() },
      ],
    })),

  appendTextChunk: (text) => {
    const { streamBuffer, messages } = get()
    const newBuffer = streamBuffer + text
    const lastMsg = messages[messages.length - 1]

    if (lastMsg?.role === 'assistant' && !lastMsg.toolCalls?.length) {
      // Update the last assistant message in place
      set({
        streamBuffer: newBuffer,
        messages: messages.map((m, i) =>
          i === messages.length - 1 ? { ...m, content: newBuffer } : m,
        ),
      })
    } else {
      // Start a new assistant message
      set({
        streamBuffer: newBuffer,
        messages: [
          ...messages,
          { id: nextId(), role: 'assistant', content: newBuffer, timestamp: Date.now() },
        ],
      })
    }
  },

  flushStreamBuffer: () => set({ streamBuffer: '' }),

  addToolCall: (event) => {
    const { messages } = get()
    const lastMsg = messages[messages.length - 1]
    const toolCall: ToolCallRecord = {
      toolUseId: event.toolUseId,
      name: event.name,
      input: event.input,
    }

    if (lastMsg?.role === 'assistant') {
      set({
        streamBuffer: '',
        messages: messages.map((m, i) =>
          i === messages.length - 1
            ? { ...m, toolCalls: [...(m.toolCalls ?? []), toolCall] }
            : m,
        ),
      })
    } else {
      set({
        streamBuffer: '',
        messages: [
          ...messages,
          {
            id: nextId(),
            role: 'assistant',
            content: '',
            toolCalls: [toolCall],
            timestamp: Date.now(),
          },
        ],
      })
    }
  },

  resolveToolCall: (toolUseId, content, isError) =>
    set((s) => ({
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
    })),

  addSystemEvent: (event) =>
    set((s) => ({
      systemEvents: [...s.systemEvents, { ...event, id: nextEvtId() }],
    })),

  setLastTurnStats: (stats) => set({ lastTurnStats: stats }),

  endSession: () => set({ status: 'idle', streamBuffer: '' }),

  dismissTimeout: () => set({ status: 'running' }),

  restoreSession: async (sessionId: string) => {
    set({ sessionId, status: 'idle', messages: [], streamBuffer: '' })

    try {
      const res = await window.electronAPI.invoke<LoadHistoryResponse>(
        IpcChannel.LOAD_HISTORY,
        { sessionId }
      )
      if (res.ok && res.messages.length > 0) {
        set({
          messages: res.messages.map((m, i) => ({
            id: `history-${i}`,
            role: m.role as 'user' | 'assistant',
            content: m.content,
            toolCalls: m.toolCalls,
            timestamp: m.timestamp,
          })),
        })
      }
    } catch (err) {
      log.error('[restoreSession] LOAD_HISTORY failed:', err)
    }
  },

  reset: () => set({ sessionId: null, status: 'idle', messages: [], systemEvents: [], lastTurnStats: null, streamBuffer: '' }),

  sendResponse: (text) => {
    const { sessionId, addUserMessage, setStatus } = get()
    if (!sessionId) return
    addUserMessage(text)
    setStatus('running')
    window.electronAPI.invoke(IpcChannel.PROMPT, { sessionId, message: text }).catch(() => {})
  },
}))
