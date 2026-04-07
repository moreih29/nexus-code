import { describe, it, expect, beforeEach } from 'vitest'
import {
  createInitialState,
  applyEvent,
  addUserMessage,
  type SessionState,
} from '../session-adapter'
import type {
  TextChunkEvent,
  ToolCallEvent,
  ToolResultEvent,
  PermissionRequestEvent,
  TurnEndEvent,
  SessionErrorEvent,
} from '@nexus/shared'

const SESSION_ID = 'test-session-1'

function textChunk(text: string): TextChunkEvent {
  return { type: 'text_chunk', sessionId: SESSION_ID, text }
}

function toolCall(id: string, name: string, input: Record<string, unknown> = {}): ToolCallEvent {
  return { type: 'tool_call', sessionId: SESSION_ID, toolCallId: id, toolName: name, toolInput: input }
}

function toolResult(id: string, result: string, isError = false): ToolResultEvent {
  return { type: 'tool_result', sessionId: SESSION_ID, toolCallId: id, result, isError }
}

function permissionRequest(permissionId: string, toolName: string, toolInput: Record<string, unknown> = {}): PermissionRequestEvent {
  return { type: 'permission_request', sessionId: SESSION_ID, permissionId, toolName, toolInput }
}

function turnEnd(): TurnEndEvent {
  return { type: 'turn_end', sessionId: SESSION_ID }
}

function sessionError(message: string): SessionErrorEvent {
  return { type: 'session_error', sessionId: SESSION_ID, message }
}

describe('createInitialState', () => {
  it('returns empty state', () => {
    const state = createInitialState()
    expect(state.messages).toHaveLength(0)
    expect(state.currentStreamingText).toBe('')
    expect(state.isStreaming).toBe(false)
    expect(state.pendingToolCalls.size).toBe(0)
    expect(state.sessionId).toBeNull()
  })
})

describe('addUserMessage', () => {
  it('appends user message', () => {
    const state = createInitialState()
    const next = addUserMessage(state, 'hello')
    expect(next.messages).toHaveLength(1)
    expect(next.messages[0].role).toBe('user')
    expect(next.messages[0].text).toBe('hello')
  })

  it('does not mutate original state', () => {
    const state = createInitialState()
    addUserMessage(state, 'hello')
    expect(state.messages).toHaveLength(0)
  })
})

describe('applyEvent — text_chunk', () => {
  it('creates new assistant streaming message', () => {
    const state = createInitialState()
    const next = applyEvent(state, textChunk('Hello'))
    expect(next.messages).toHaveLength(1)
    expect(next.messages[0].role).toBe('assistant')
    expect(next.messages[0].text).toBe('Hello')
    expect(next.messages[0].isStreaming).toBe(true)
    expect(next.isStreaming).toBe(true)
    expect(next.currentStreamingText).toBe('Hello')
  })

  it('accumulates text across multiple chunks', () => {
    let state = createInitialState()
    state = applyEvent(state, textChunk('Hello'))
    state = applyEvent(state, textChunk(', '))
    state = applyEvent(state, textChunk('world!'))
    expect(state.messages).toHaveLength(1)
    expect(state.messages[0].text).toBe('Hello, world!')
    expect(state.currentStreamingText).toBe('Hello, world!')
  })

  it('creates new assistant message after user message', () => {
    let state = createInitialState()
    state = addUserMessage(state, 'hi')
    state = applyEvent(state, textChunk('response'))
    expect(state.messages).toHaveLength(2)
    expect(state.messages[1].role).toBe('assistant')
    expect(state.messages[1].text).toBe('response')
  })

  it('sets sessionId from first event', () => {
    const state = createInitialState()
    const next = applyEvent(state, textChunk('hi'))
    expect(next.sessionId).toBe(SESSION_ID)
  })
})

describe('applyEvent — tool_call', () => {
  it('adds tool call to pending map and message', () => {
    const state = createInitialState()
    const next = applyEvent(state, toolCall('tc-1', 'Read', { file: 'foo.ts' }))
    expect(next.pendingToolCalls.has('tc-1')).toBe(true)
    expect(next.pendingToolCalls.get('tc-1')?.status).toBe('running')
    expect(next.messages).toHaveLength(1)
    expect(next.messages[0].toolCalls).toHaveLength(1)
    expect(next.messages[0].toolCalls![0].name).toBe('Read')
  })

  it('commits streaming text before adding tool call', () => {
    let state = createInitialState()
    state = applyEvent(state, textChunk('thinking...'))
    state = applyEvent(state, toolCall('tc-1', 'Read'))
    expect(state.currentStreamingText).toBe('')
    expect(state.messages.length).toBeGreaterThanOrEqual(1)
    const assistantMsgs = state.messages.filter((m) => m.role === 'assistant')
    const textMsg = assistantMsgs.find((m) => m.text === 'thinking...')
    expect(textMsg).toBeDefined()
  })

  it('adds multiple tool calls to same message', () => {
    let state = createInitialState()
    state = applyEvent(state, toolCall('tc-1', 'Read'))
    state = applyEvent(state, toolCall('tc-2', 'Write'))
    const assistantMsg = state.messages.find((m) => m.role === 'assistant')
    expect(assistantMsg?.toolCalls).toHaveLength(2)
  })
})

describe('applyEvent — tool_result', () => {
  it('updates tool call status to success', () => {
    let state = createInitialState()
    state = applyEvent(state, toolCall('tc-1', 'Read'))
    state = applyEvent(state, toolResult('tc-1', 'file contents'))
    const tc = state.pendingToolCalls.get('tc-1')
    expect(tc?.status).toBe('success')
    expect(tc?.result).toBe('file contents')
    expect(tc?.isError).toBe(false)
  })

  it('updates tool call status to error', () => {
    let state = createInitialState()
    state = applyEvent(state, toolCall('tc-1', 'Read'))
    state = applyEvent(state, toolResult('tc-1', 'not found', true))
    const tc = state.pendingToolCalls.get('tc-1')
    expect(tc?.status).toBe('error')
    expect(tc?.isError).toBe(true)
  })

  it('reflects result in message toolCalls array', () => {
    let state = createInitialState()
    state = applyEvent(state, toolCall('tc-1', 'Read'))
    state = applyEvent(state, toolResult('tc-1', 'contents'))
    const msg = state.messages.find((m) => m.toolCalls?.some((tc) => tc.id === 'tc-1'))
    expect(msg?.toolCalls![0].status).toBe('success')
    expect(msg?.toolCalls![0].result).toBe('contents')
  })

  it('no-ops for unknown toolCallId', () => {
    const state = createInitialState()
    const next = applyEvent(state, toolResult('unknown', 'result'))
    expect(next).toBe(state)
  })
})

describe('applyEvent — permission_request', () => {
  it('attaches permission request to last assistant message', () => {
    let state = createInitialState()
    state = applyEvent(state, textChunk('about to run bash'))
    state = applyEvent(state, permissionRequest('perm-1', 'Bash', { command: 'ls' }))
    const last = state.messages[state.messages.length - 1]
    expect(last.permissionRequest).toBeDefined()
    expect(last.permissionRequest?.id).toBe('perm-1')
    expect(last.permissionRequest?.toolName).toBe('Bash')
  })

  it('creates new assistant message if no prior assistant message', () => {
    let state = createInitialState()
    state = addUserMessage(state, 'run something')
    state = applyEvent(state, permissionRequest('perm-1', 'Bash'))
    expect(state.messages).toHaveLength(2)
    expect(state.messages[1].role).toBe('assistant')
    expect(state.messages[1].permissionRequest?.id).toBe('perm-1')
  })
})

describe('applyEvent — turn_end', () => {
  it('sets isStreaming to false', () => {
    let state = createInitialState()
    state = applyEvent(state, textChunk('done'))
    state = applyEvent(state, turnEnd())
    expect(state.isStreaming).toBe(false)
  })

  it('commits remaining streaming text', () => {
    let state = createInitialState()
    state = applyEvent(state, textChunk('final text'))
    state = applyEvent(state, turnEnd())
    expect(state.currentStreamingText).toBe('')
    const last = state.messages[state.messages.length - 1]
    expect(last.text).toBe('final text')
    expect(last.isStreaming).toBe(false)
  })
})

describe('applyEvent — session_error', () => {
  it('adds error message with role assistant', () => {
    const state = createInitialState()
    const next = applyEvent(state, sessionError('something went wrong'))
    expect(next.messages).toHaveLength(1)
    expect(next.messages[0].role).toBe('assistant')
    expect(next.messages[0].text).toBe('something went wrong')
  })

  it('sets isStreaming to false', () => {
    let state = createInitialState()
    state = applyEvent(state, textChunk('partial'))
    state = applyEvent(state, sessionError('error occurred'))
    expect(state.isStreaming).toBe(false)
  })
})

describe('composite scenario: text → tool_call → tool_result → text', () => {
  let state: SessionState

  beforeEach(() => {
    state = createInitialState()
    state = addUserMessage(state, 'refactor this file')
    state = applyEvent(state, textChunk('Let me read the file first.'))
    state = applyEvent(state, toolCall('tc-1', 'Read', { file_path: 'src/foo.ts' }))
    state = applyEvent(state, toolResult('tc-1', 'export function foo() {}'))
    state = applyEvent(state, textChunk('Now I will edit it.'))
    state = applyEvent(state, toolCall('tc-2', 'Edit', { file_path: 'src/foo.ts' }))
    state = applyEvent(state, toolResult('tc-2', 'edited successfully'))
    state = applyEvent(state, textChunk(' Done!'))
    state = applyEvent(state, turnEnd())
  })

  it('has user message first', () => {
    expect(state.messages[0].role).toBe('user')
    expect(state.messages[0].text).toBe('refactor this file')
  })

  it('committed streaming text becomes non-streaming', () => {
    const streamingMsgs = state.messages.filter((m) => m.isStreaming)
    expect(streamingMsgs).toHaveLength(0)
  })

  it('tool calls have results', () => {
    expect(state.pendingToolCalls.get('tc-1')?.status).toBe('success')
    expect(state.pendingToolCalls.get('tc-2')?.status).toBe('success')
  })

  it('isStreaming is false after turn_end', () => {
    expect(state.isStreaming).toBe(false)
  })

  it('currentStreamingText is empty after turn_end', () => {
    expect(state.currentStreamingText).toBe('')
  })
})
