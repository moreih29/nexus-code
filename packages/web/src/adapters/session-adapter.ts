import type { SessionEvent } from '@nexus/shared'

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

export interface SessionState {
  messages: ChatMessage[]
  currentStreamingText: string
  isStreaming: boolean
  pendingToolCalls: Map<string, ToolCallState>
  sessionId: string | null
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
      const toolCall: ToolCallState = {
        id: event.toolCallId,
        name: event.toolName,
        input: event.toolInput,
        status: 'running',
      }

      const newPending = new Map(state.pendingToolCalls)
      newPending.set(event.toolCallId, toolCall)

      let nextState = state
      if (state.currentStreamingText) {
        nextState = commitStreamingText(state)
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

      return {
        ...state,
        sessionId: state.sessionId ?? event.sessionId,
        messages,
        pendingToolCalls: newPending,
      }
    }

    case 'permission_request': {
      const permRequest: PermissionRequestState = {
        id: event.permissionId,
        toolName: event.toolName,
        toolInput: event.toolInput,
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

    case 'turn_end': {
      let nextState = state
      if (state.currentStreamingText) {
        nextState = commitStreamingText(state)
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
