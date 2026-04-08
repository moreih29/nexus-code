import { describe, it, expect, beforeEach } from 'vitest'
import { useChatStore } from '../chat-store'
import type { ChatMessage } from '../../adapters/session-adapter'
import type {
  TextChunkEvent,
  TurnEndEvent,
} from '@nexus/shared'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SESSION_ID = 'sess-test-1'

function textChunk(text: string, sessionId = SESSION_ID): TextChunkEvent {
  return { type: 'text_chunk', sessionId, text }
}

function turnEnd(sessionId = SESSION_ID): TurnEndEvent {
  return { type: 'turn_end', sessionId }
}

function resetStore() {
  useChatStore.getState().resetSession()
}

beforeEach(() => {
  resetStore()
})

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

describe('initial state', () => {
  it('has correct default values', () => {
    const state = useChatStore.getState()
    expect(state.sessionState.messages).toHaveLength(0)
    expect(state.sessionId).toBeNull()
    expect(state.restorableSessionId).toBeNull()
    expect(state.isConnected).toBe(false)
    expect(state.activeTab).toBe('main')
    expect(state.isLoadingHistory).toBe(false)
    expect(state.isWaitingResponse).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// applyServerEvent
// ---------------------------------------------------------------------------

describe('applyServerEvent', () => {
  it('text_chunk event updates sessionState messages', () => {
    useChatStore.getState().applyServerEvent(textChunk('hello'))
    const { sessionState } = useChatStore.getState()
    expect(sessionState.messages).toHaveLength(1)
    expect(sessionState.messages[0].role).toBe('assistant')
    expect(sessionState.messages[0].text).toBe('hello')
  })

  it('sets isWaitingResponse to false after any event', () => {
    useChatStore.setState({ isWaitingResponse: true })
    useChatStore.getState().applyServerEvent(textChunk('response'))
    expect(useChatStore.getState().isWaitingResponse).toBe(false)
  })

  it('sets sessionId from first event when sessionId is null', () => {
    useChatStore.getState().applyServerEvent(textChunk('hi', 'new-session-42'))
    expect(useChatStore.getState().sessionId).toBe('new-session-42')
  })

  it('does not overwrite existing sessionId with event sessionId', () => {
    useChatStore.setState({ sessionId: 'existing-session' })
    useChatStore.getState().applyServerEvent(textChunk('hi', 'other-session'))
    expect(useChatStore.getState().sessionId).toBe('existing-session')
  })

  it('turn_end after text_chunk finalizes message', () => {
    useChatStore.getState().applyServerEvent(textChunk('done'))
    useChatStore.getState().applyServerEvent(turnEnd())
    const { sessionState } = useChatStore.getState()
    expect(sessionState.isStreaming).toBe(false)
    expect(sessionState.messages[0].isStreaming).toBeFalsy()
  })
})

// ---------------------------------------------------------------------------
// sendMessage
// ---------------------------------------------------------------------------

describe('sendMessage', () => {
  it('adds user message to sessionState', () => {
    useChatStore.getState().sendMessage('test input')
    const { sessionState } = useChatStore.getState()
    expect(sessionState.messages).toHaveLength(1)
    expect(sessionState.messages[0].role).toBe('user')
    expect(sessionState.messages[0].text).toBe('test input')
  })

  it('sets isWaitingResponse to true', () => {
    useChatStore.getState().sendMessage('test input')
    expect(useChatStore.getState().isWaitingResponse).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// setSessionId
// ---------------------------------------------------------------------------

describe('setSessionId', () => {
  it('updates sessionId', () => {
    useChatStore.getState().setSessionId('my-session')
    expect(useChatStore.getState().sessionId).toBe('my-session')
  })
})

// ---------------------------------------------------------------------------
// setConnected
// ---------------------------------------------------------------------------

describe('setConnected', () => {
  it('sets isConnected to true', () => {
    useChatStore.getState().setConnected(true)
    expect(useChatStore.getState().isConnected).toBe(true)
  })

  it('sets isConnected to false', () => {
    useChatStore.setState({ isConnected: true })
    useChatStore.getState().setConnected(false)
    expect(useChatStore.getState().isConnected).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// resetSession
// ---------------------------------------------------------------------------

describe('resetSession', () => {
  it('resets all state to initial values', () => {
    useChatStore.setState({
      sessionId: 'old-session',
      restorableSessionId: 'old-restorable',
      isConnected: true,
      activeTab: 'agent-1',
      isLoadingHistory: true,
      isWaitingResponse: true,
    })
    useChatStore.getState().sendMessage('some text')
    useChatStore.getState().resetSession()

    const state = useChatStore.getState()
    expect(state.sessionState.messages).toHaveLength(0)
    expect(state.sessionId).toBeNull()
    expect(state.restorableSessionId).toBeNull()
    expect(state.isConnected).toBe(false)
    expect(state.activeTab).toBe('main')
    expect(state.isLoadingHistory).toBe(false)
    expect(state.isWaitingResponse).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// restoreFromHistory
// ---------------------------------------------------------------------------

describe('restoreFromHistory', () => {
  const sampleMessages: ChatMessage[] = [
    { id: 'msg-1', role: 'user', text: 'Hello' },
    { id: 'msg-2', role: 'assistant', text: 'Hi there' },
  ]

  it('sets sessionId to null and restorableSessionId to provided id', () => {
    useChatStore.setState({ sessionId: 'active-session' })
    useChatStore.getState().restoreFromHistory('restorable-123', sampleMessages)

    const state = useChatStore.getState()
    expect(state.sessionId).toBeNull()
    expect(state.restorableSessionId).toBe('restorable-123')
  })

  it('replaces sessionState messages with provided messages', () => {
    useChatStore.getState().restoreFromHistory('r-1', sampleMessages)
    const { sessionState } = useChatStore.getState()
    expect(sessionState.messages).toHaveLength(2)
    expect(sessionState.messages[0].text).toBe('Hello')
    expect(sessionState.messages[1].text).toBe('Hi there')
  })

  it('sets restorableSessionId to null when restorableId is empty string', () => {
    useChatStore.getState().restoreFromHistory('', sampleMessages)
    expect(useChatStore.getState().restorableSessionId).toBeNull()
  })

  it('clears isLoadingHistory and isWaitingResponse', () => {
    useChatStore.setState({ isLoadingHistory: true, isWaitingResponse: true })
    useChatStore.getState().restoreFromHistory('r-1', sampleMessages)
    expect(useChatStore.getState().isLoadingHistory).toBe(false)
    expect(useChatStore.getState().isWaitingResponse).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// getSubagents
// ---------------------------------------------------------------------------

describe('getSubagents', () => {
  it('returns empty array when no subagents', () => {
    expect(useChatStore.getState().getSubagents()).toHaveLength(0)
  })

  it('returns mapped subagent list from sessionState', () => {
    useChatStore.setState({
      sessionState: {
        ...useChatStore.getState().sessionState,
        subagents: [
          {
            id: 'sa-1',
            name: 'Engineer',
            type: 'Engineer',
            status: 'running',
            summary: 'implementing feature',
            spawnedAt: Date.now(),
          },
        ],
      },
    })
    const subagents = useChatStore.getState().getSubagents()
    expect(subagents).toHaveLength(1)
    expect(subagents[0].id).toBe('sa-1')
    expect(subagents[0].name).toBe('Engineer')
    expect(subagents[0].status).toBe('running')
  })
})

// ---------------------------------------------------------------------------
// getActiveSubagent
// ---------------------------------------------------------------------------

describe('getActiveSubagent', () => {
  it('returns null when activeTab is main', () => {
    useChatStore.setState({ activeTab: 'main' })
    expect(useChatStore.getState().getActiveSubagent()).toBeNull()
  })

  it('returns matching subagent when activeTab matches a subagent id', () => {
    useChatStore.setState({
      activeTab: 'sa-1',
      sessionState: {
        ...useChatStore.getState().sessionState,
        subagents: [
          {
            id: 'sa-1',
            name: 'Tester',
            type: 'Tester',
            status: 'done',
            summary: 'running tests',
            spawnedAt: Date.now(),
          },
        ],
      },
    })
    const active = useChatStore.getState().getActiveSubagent()
    expect(active).not.toBeNull()
    expect(active!.id).toBe('sa-1')
    expect(active!.name).toBe('Tester')
  })

  it('returns null when activeTab does not match any subagent', () => {
    useChatStore.setState({ activeTab: 'nonexistent-id' })
    expect(useChatStore.getState().getActiveSubagent()).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// getActiveMessages
// ---------------------------------------------------------------------------

describe('getActiveMessages', () => {
  it('returns sessionState.messages', () => {
    useChatStore.getState().sendMessage('msg a')
    const msgs = useChatStore.getState().getActiveMessages()
    expect(msgs).toHaveLength(1)
    expect(msgs[0].text).toBe('msg a')
  })
})

// ---------------------------------------------------------------------------
// setActiveTab
// ---------------------------------------------------------------------------

describe('setActiveTab', () => {
  it('updates activeTab', () => {
    useChatStore.getState().setActiveTab('sa-99')
    expect(useChatStore.getState().activeTab).toBe('sa-99')
  })

  it('can switch back to main', () => {
    useChatStore.setState({ activeTab: 'sa-99' })
    useChatStore.getState().setActiveTab('main')
    expect(useChatStore.getState().activeTab).toBe('main')
  })
})
