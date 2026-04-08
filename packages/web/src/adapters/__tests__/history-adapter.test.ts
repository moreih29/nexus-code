import { describe, it, expect } from 'vitest'
import { historyMessagesToChatMessages } from '../session-adapter'
import type { HistoryMessage } from '../../api/session'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function userMsg(overrides: Partial<HistoryMessage> & { text?: string }): HistoryMessage {
  const { text = 'hello', ...rest } = overrides
  return {
    type: 'user',
    uuid: 'u-1',
    content: { text },
    isSidechain: false,
    ...rest,
  }
}

function assistantMsg(
  blocks: Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }>,
  overrides: Partial<HistoryMessage> = {},
): HistoryMessage {
  return {
    type: 'assistant',
    uuid: 'a-1',
    content: { blocks },
    isSidechain: false,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('historyMessagesToChatMessages', () => {
  it('returns empty array for empty input', () => {
    expect(historyMessagesToChatMessages([])).toEqual([])
  })

  it('converts user message — extracts content.text', () => {
    const result = historyMessagesToChatMessages([userMsg({ text: 'What is the weather?' })])
    expect(result).toHaveLength(1)
    expect(result[0].role).toBe('user')
    expect(result[0].text).toBe('What is the weather?')
  })

  it('converts assistant message — merges text blocks with newline', () => {
    const msg = assistantMsg([
      { type: 'text', text: 'First line' },
      { type: 'text', text: 'Second line' },
    ])
    const result = historyMessagesToChatMessages([msg])
    expect(result).toHaveLength(1)
    expect(result[0].role).toBe('assistant')
    expect(result[0].text).toBe('First line\nSecond line')
  })

  it('converts assistant message tool_use blocks → toolCalls array', () => {
    const msg = assistantMsg([
      {
        type: 'tool_use',
        id: 'tc-1',
        name: 'Read',
        input: { file_path: 'src/foo.ts' },
      },
    ])
    const result = historyMessagesToChatMessages([msg])
    expect(result).toHaveLength(1)
    expect(result[0].toolCalls).toHaveLength(1)
    expect(result[0].toolCalls![0].id).toBe('tc-1')
    expect(result[0].toolCalls![0].name).toBe('Read')
    expect(result[0].toolCalls![0].input).toEqual({ file_path: 'src/foo.ts' })
    expect(result[0].toolCalls![0].status).toBe('success')
  })

  it('filters out isSidechain: true messages', () => {
    const result = historyMessagesToChatMessages([
      userMsg({ uuid: 'u-visible', text: 'visible', isSidechain: false }),
      userMsg({ uuid: 'u-hidden', text: 'sidechain', isSidechain: true }),
    ])
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('u-visible')
  })

  it('generates id when uuid is null/undefined', () => {
    const msg = {
      type: 'user' as const,
      uuid: null as unknown as string,
      content: { text: 'no uuid' },
      isSidechain: false,
    } satisfies HistoryMessage
    const result = historyMessagesToChatMessages([msg])
    expect(result).toHaveLength(1)
    expect(result[0].id).toBeTruthy()
    expect(result[0].id.startsWith('h-')).toBe(true)
  })

  it('filters out messages with empty text and no toolCalls', () => {
    const msg = assistantMsg([]) // no blocks → text='', no toolCalls
    const result = historyMessagesToChatMessages([msg])
    expect(result).toHaveLength(0)
  })

  it('handles tool_use block with missing input — defaults to empty object', () => {
    const msg: HistoryMessage = {
      type: 'assistant',
      uuid: 'a-2',
      content: {
        blocks: [
          { type: 'tool_use', id: 'tc-2', name: 'Bash' },
        ],
      },
      isSidechain: false,
    }
    const result = historyMessagesToChatMessages([msg])
    expect(result).toHaveLength(1)
    expect(result[0].toolCalls![0].input).toEqual({})
  })

  it('handles assistant message with undefined blocks — returns empty text', () => {
    const msg: HistoryMessage = {
      type: 'assistant',
      uuid: 'a-3',
      content: {},
      isSidechain: false,
    }
    // empty text + no toolCalls → filtered out
    const result = historyMessagesToChatMessages([msg])
    expect(result).toHaveLength(0)
  })

  it('tool_result type message — produces user role with empty text (filtered out)', () => {
    // tool_result falls into the else branch (treated as assistant) with no blocks
    const msg: HistoryMessage = {
      type: 'tool_result',
      uuid: 'tr-1',
      content: {},
      isSidechain: false,
    }
    // No text, no toolCalls → filtered
    const result = historyMessagesToChatMessages([msg])
    expect(result).toHaveLength(0)
  })

  it('mixed text + tool_use assistant message produces both text and toolCalls', () => {
    const msg = assistantMsg([
      { type: 'text', text: 'Let me read that file.' },
      { type: 'tool_use', id: 'tc-3', name: 'Read', input: { file_path: 'a.ts' } },
    ])
    const result = historyMessagesToChatMessages([msg])
    expect(result).toHaveLength(1)
    expect(result[0].text).toBe('Let me read that file.')
    expect(result[0].toolCalls).toHaveLength(1)
    expect(result[0].toolCalls![0].name).toBe('Read')
  })

  it('preserves order of multiple messages', () => {
    const msgs: HistoryMessage[] = [
      userMsg({ uuid: 'u-1', text: 'first' }),
      assistantMsg([{ type: 'text', text: 'second' }], { uuid: 'a-1' }),
      userMsg({ uuid: 'u-2', text: 'third' }),
    ]
    const result = historyMessagesToChatMessages(msgs)
    expect(result).toHaveLength(3)
    expect(result[0].id).toBe('u-1')
    expect(result[1].id).toBe('a-1')
    expect(result[2].id).toBe('u-2')
  })
})
