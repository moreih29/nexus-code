import type { SessionEvent } from '@nexus/shared'
import type { HistoryMessage } from '../api/session.js'

let _historyIdCounter = 1000
function genHistoryId(): string {
  return `h-${++_historyIdCounter}`
}

export function historyMessagesToChatMessages(messages: HistoryMessage[]): ChatMessage[] {
  return messages
    .filter((m) => !m.isSidechain)
    .map((m): ChatMessage => {
      if (m.type === 'user') {
        const content = m.content as { text?: string; kind?: string }
        return {
          id: m.uuid ?? genHistoryId(),
          role: 'user',
          text: content?.text ?? '',
        }
      }
      const content = m.content as {
        blocks?: Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> | string }>
      }
      const textBlocks = content?.blocks?.filter((b) => b.type === 'text') ?? []
      const text = textBlocks.map((b) => b.text ?? '').join('\n')
      const toolUseBlocks = content?.blocks?.filter((b) => b.type === 'tool_use') ?? []
      const toolCalls: ToolCallState[] = toolUseBlocks.map((b) => ({
        id: b.id ?? '',
        name: b.name ?? '',
        input: (typeof b.input === 'object' && b.input !== null ? b.input : {}) as Record<string, unknown>,
        status: 'success' as const,
      }))
      const msg: ChatMessage = {
        id: m.uuid ?? genHistoryId(),
        role: 'assistant',
        text,
      }
      if (toolCalls.length > 0) msg.toolCalls = toolCalls
      return msg
    })
    .filter((m) => m.text.length > 0 || (m.toolCalls && m.toolCalls.length > 0))
}

export interface ToolCallState {
  id: string
  name: string
  input: Record<string, unknown>
  status: 'running' | 'success' | 'error'
  result?: string
  isError?: boolean
}

export interface PermissionRequestState {
  id: string
  toolName: string
  toolInput: Record<string, unknown>
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  toolCalls?: ToolCallState[]
  permissionRequest?: PermissionRequestState
  isStreaming?: boolean
}

export interface SubagentState {
  id: string // toolCallId of the Task call
  name: string
  type: string
  status: 'running' | 'done' | 'waiting_permission'
  summary: string
  durationSec?: number
  spawnedAt: number // timestamp ms
}

export interface SessionState {
  messages: ChatMessage[]
  currentStreamingText: string
  isStreaming: boolean
  pendingToolCalls: Map<string, ToolCallState>
  sessionId: string | null
  subagents: SubagentState[]
}

let _idCounter = 0
function genId(): string {
  return `msg-${++_idCounter}`
}

export function createInitialState(): SessionState {
  return {
    messages: [],
    currentStreamingText: '',
    isStreaming: false,
    pendingToolCalls: new Map(),
    sessionId: null,
    subagents: [],
  }
}

function lastMessage(messages: ChatMessage[]): ChatMessage | undefined {
  return messages[messages.length - 1]
}

function commitStreamingText(state: SessionState): SessionState {
  if (!state.currentStreamingText) return state

  const last = lastMessage(state.messages)
  if (last && last.isStreaming) {
    const updated: ChatMessage = { ...last, text: state.currentStreamingText, isStreaming: false }
    return {
      ...state,
      messages: [...state.messages.slice(0, -1), updated],
      currentStreamingText: '',
    }
  }

  return {
    ...state,
    messages: [
      ...state.messages,
      {
        id: genId(),
        role: 'assistant',
        text: state.currentStreamingText,
        isStreaming: false,
      },
    ],
    currentStreamingText: '',
  }
}

function inferSubagentType(input: Record<string, unknown>): string {
  const text = [
    typeof input['description'] === 'string' ? input['description'] : '',
    typeof input['prompt'] === 'string' ? input['prompt'] : '',
  ]
    .join(' ')
    .toLowerCase()

  if (text.includes('engineer') || text.includes('implement') || text.includes('코드') || text.includes('구현')) {
    return 'Engineer'
  }
  if (text.includes('research') || text.includes('search') || text.includes('리서치') || text.includes('검색')) {
    return 'Researcher'
  }
  if (text.includes('write') || text.includes('document') || text.includes('문서') || text.includes('작성')) {
    return 'Writer'
  }
  if (text.includes('test') || text.includes('verify') || text.includes('테스트') || text.includes('검증')) {
    return 'Tester'
  }
  return 'Explore'
}

export function applyEvent(state: SessionState, event: SessionEvent): SessionState {
  switch (event.type) {
    case 'text_chunk': {
      const newText = state.currentStreamingText + event.text
      const last = lastMessage(state.messages)

      if (!last || last.role === 'user') {
        const streamingMsg: ChatMessage = {
          id: genId(),
          role: 'assistant',
          text: newText,
          isStreaming: true,
        }
        return {
          ...state,
          sessionId: state.sessionId ?? event.sessionId,
          messages: [...state.messages, streamingMsg],
          currentStreamingText: newText,
          isStreaming: true,
        }
      }

      const updatedLast: ChatMessage = { ...last, text: newText, isStreaming: true }
      return {
        ...state,
        sessionId: state.sessionId ?? event.sessionId,
        messages: [...state.messages.slice(0, -1), updatedLast],
        currentStreamingText: newText,
        isStreaming: true,
      }
    }

    case 'tool_call': {
      const toolInput = typeof event.toolInput === 'string' ? {} : event.toolInput
      const toolCall: ToolCallState = {
        id: event.toolCallId,
        name: event.toolName,
        input: toolInput,
        status: 'running',
      }

      const newPending = new Map(state.pendingToolCalls)
      newPending.set(event.toolCallId, toolCall)

      let nextState = state
      if (state.currentStreamingText) {
        nextState = commitStreamingText(state)
      }

      // Track subagent if this is a Task tool call
      let newSubagents = nextState.subagents
      if (event.toolName === 'Task') {
        const description =
          typeof toolInput['description'] === 'string' ? toolInput['description'] : ''
        const prompt =
          typeof toolInput['prompt'] === 'string' ? toolInput['prompt'] : ''
        const name = description || prompt.slice(0, 40) || `서브에이전트 #${nextState.subagents.length + 1}`
        const subagent: SubagentState = {
          id: event.toolCallId,
          name,
          type: inferSubagentType(toolInput),
          status: 'running',
          summary: prompt.slice(0, 80) || description,
          spawnedAt: Date.now(),
        }
        newSubagents = [...nextState.subagents, subagent]
      }

      const last = lastMessage(nextState.messages)
      if (last && last.role === 'assistant' && !last.isStreaming) {
        const existing = last.toolCalls ?? []
        const updatedLast: ChatMessage = {
          ...last,
          toolCalls: [...existing, toolCall],
        }
        return {
          ...nextState,
          sessionId: nextState.sessionId ?? event.sessionId,
          messages: [...nextState.messages.slice(0, -1), updatedLast],
          pendingToolCalls: newPending,
          subagents: newSubagents,
        }
      }

      const newMsg: ChatMessage = {
        id: genId(),
        role: 'assistant',
        text: '',
        toolCalls: [toolCall],
      }
      return {
        ...nextState,
        sessionId: nextState.sessionId ?? event.sessionId,
        messages: [...nextState.messages, newMsg],
        pendingToolCalls: newPending,
        subagents: newSubagents,
      }
    }

    case 'tool_result': {
      const existing = state.pendingToolCalls.get(event.toolCallId)
      if (!existing) return state

      const updated: ToolCallState = {
        ...existing,
        status: event.isError ? 'error' : 'success',
        result: event.result,
        isError: event.isError,
      }
      const newPending = new Map(state.pendingToolCalls)
      newPending.set(event.toolCallId, updated)

      const messages = state.messages.map((msg) => {
        if (!msg.toolCalls) return msg
        const idx = msg.toolCalls.findIndex((tc) => tc.id === event.toolCallId)
        if (idx === -1) return msg
        const newToolCalls = [...msg.toolCalls]
        newToolCalls[idx] = updated
        return { ...msg, toolCalls: newToolCalls }
      })

      // Mark subagent as done when its Task tool_result arrives
      const newSubagents = state.subagents.map((sa) => {
        if (sa.id !== event.toolCallId) return sa
        const durationSec = Math.round((Date.now() - sa.spawnedAt) / 1000)
        const resultSummary = event.result.slice(0, 80) || sa.summary
        return { ...sa, status: 'done' as const, durationSec, summary: resultSummary }
      })

      return {
        ...state,
        sessionId: state.sessionId ?? event.sessionId,
        messages,
        pendingToolCalls: newPending,
        subagents: newSubagents,
      }
    }

    case 'permission_request': {
      const permRequest: PermissionRequestState = {
        id: event.permissionId,
        toolName: event.toolName,
        toolInput: typeof event.toolInput === 'string' ? {} : event.toolInput,
      }

      const last = lastMessage(state.messages)
      if (last && last.role === 'assistant') {
        const updatedLast: ChatMessage = { ...last, permissionRequest: permRequest }
        return {
          ...state,
          sessionId: state.sessionId ?? event.sessionId,
          messages: [...state.messages.slice(0, -1), updatedLast],
        }
      }

      const newMsg: ChatMessage = {
        id: genId(),
        role: 'assistant',
        text: '',
        permissionRequest: permRequest,
      }
      return {
        ...state,
        sessionId: state.sessionId ?? event.sessionId,
        messages: [...state.messages, newMsg],
      }
    }

    case 'permission_settled': {
      const messages = state.messages.map((msg) => {
        if (msg.permissionRequest?.id === event.permissionId) {
          return { ...msg, permissionRequest: undefined }
        }
        return msg
      })
      return { ...state, messages }
    }

    case 'turn_end': {
      let nextState = state
      if (state.currentStreamingText) {
        nextState = commitStreamingText(state)
      }

      // Force-complete any pending tool calls — turn_end means CLI is done
      if (nextState.pendingToolCalls.size > 0) {
        const completedPending = new Map(nextState.pendingToolCalls)
        const messages = nextState.messages.map((msg) => {
          if (!msg.toolCalls) return msg
          const updated = msg.toolCalls.map((tc) => {
            if (tc.status === 'running') {
              const completed = { ...tc, status: 'success' as const }
              completedPending.set(tc.id, completed)
              return completed
            }
            return tc
          })
          return { ...msg, toolCalls: updated }
        })
        nextState = { ...nextState, messages, pendingToolCalls: completedPending }
      }

      const last = lastMessage(nextState.messages)
      if (last && last.isStreaming) {
        const updatedLast: ChatMessage = { ...last, isStreaming: false }
        return {
          ...nextState,
          sessionId: nextState.sessionId ?? event.sessionId,
          messages: [...nextState.messages.slice(0, -1), updatedLast],
          isStreaming: false,
        }
      }
      return {
        ...nextState,
        sessionId: nextState.sessionId ?? event.sessionId,
        isStreaming: false,
      }
    }

    case 'session_error': {
      const errorMsg: ChatMessage = {
        id: genId(),
        role: 'assistant',
        text: event.message,
      }
      return {
        ...state,
        sessionId: state.sessionId ?? event.sessionId,
        messages: [...state.messages, errorMsg],
        isStreaming: false,
      }
    }
  }
}

export function addUserMessage(state: SessionState, text: string): SessionState {
  const msg: ChatMessage = {
    id: genId(),
    role: 'user',
    text,
  }
  return {
    ...state,
    messages: [...state.messages, msg],
  }
}
