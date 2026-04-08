import { describe, it, expect } from 'vitest'
import { createInitialState, applyEvent } from '../session-adapter'
import type { ToolCallEvent } from '@nexus/shared'

const SESSION_ID = 'test-infer-session'

function taskCall(id: string, description: string, prompt = ''): ToolCallEvent {
  return {
    type: 'tool_call',
    sessionId: SESSION_ID,
    toolCallId: id,
    toolName: 'Task',
    toolInput: { description, prompt },
  }
}

// inferSubagentType is not exported; test indirectly via applyEvent Task tool calls.

describe('inferSubagentType via applyEvent Task tool_call', () => {
  it('returns Engineer for engineer keyword', () => {
    const state = createInitialState()
    const next = applyEvent(state, taskCall('tc-1', 'engineer this module'))
    expect(next.subagents[0].type).toBe('Engineer')
  })

  it('returns Researcher for research keyword', () => {
    const state = createInitialState()
    const next = applyEvent(state, taskCall('tc-2', 'research the best approach'))
    expect(next.subagents[0].type).toBe('Researcher')
  })

  it('returns Writer for 문서 keyword', () => {
    const state = createInitialState()
    const next = applyEvent(state, taskCall('tc-3', '문서 작성해줘', ''))
    // '문서' matches Writer
    expect(next.subagents[0].type).toBe('Writer')
  })

  it('returns Tester for 테스트 keyword', () => {
    const state = createInitialState()
    const next = applyEvent(state, taskCall('tc-4', '테스트 실행', ''))
    expect(next.subagents[0].type).toBe('Tester')
  })

  it('returns Explore when no keyword matches', () => {
    const state = createInitialState()
    const next = applyEvent(state, taskCall('tc-5', 'do something interesting', ''))
    expect(next.subagents[0].type).toBe('Explore')
  })
})
