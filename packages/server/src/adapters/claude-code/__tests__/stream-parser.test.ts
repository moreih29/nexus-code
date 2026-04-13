import { describe, it, expect, vi } from 'vitest'
import { StreamParser } from '../stream-parser.js'

describe('StreamParser', () => {
  describe('session_id (backward compat)', () => {
    it('emits session_id from system init message', () => {
      const parser = new StreamParser()
      const handler = vi.fn()
      parser.on('session_id', handler)

      parser.feed(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'abc-123' }))

      expect(handler).toHaveBeenCalledOnce()
      expect(handler).toHaveBeenCalledWith({ sessionId: 'abc-123' })
    })
  })

  describe('init', () => {
    it('emits init with sessionId from system init message', () => {
      const parser = new StreamParser()
      const handler = vi.fn()
      parser.on('init', handler)

      parser.feed(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'abc-123' }))

      expect(handler).toHaveBeenCalledOnce()
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'abc-123' }))
    })

    it('emits init with model and permissionMode when present', () => {
      const parser = new StreamParser()
      const handler = vi.fn()
      parser.on('init', handler)

      parser.feed(
        JSON.stringify({
          type: 'system',
          subtype: 'init',
          session_id: 'abc-123',
          model: 'claude-opus-4',
          permissionMode: 'default',
          tools: ['bash', 'read'],
        }),
      )

      expect(handler).toHaveBeenCalledOnce()
      expect(handler).toHaveBeenCalledWith({
        sessionId: 'abc-123',
        model: 'claude-opus-4',
        permissionMode: 'default',
        tools: ['bash', 'read'],
      })
    })

    it('emits both session_id and init for backward compat', () => {
      const parser = new StreamParser()
      const legacyHandler = vi.fn()
      const initHandler = vi.fn()
      parser.on('session_id', legacyHandler)
      parser.on('init', initHandler)

      parser.feed(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'xyz' }))

      expect(legacyHandler).toHaveBeenCalledOnce()
      expect(initHandler).toHaveBeenCalledOnce()
    })
  })

  describe('text_chunk', () => {
    it('emits text_chunk from assistant text block', () => {
      const parser = new StreamParser()
      const handler = vi.fn()
      parser.on('text_chunk', handler)

      parser.feed(
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Hello, world!' }] },
        }),
      )

      expect(handler).toHaveBeenCalledOnce()
      expect(handler).toHaveBeenCalledWith({ text: 'Hello, world!' })
    })

    it('emits multiple text_chunk events for multiple text blocks', () => {
      const parser = new StreamParser()
      const handler = vi.fn()
      parser.on('text_chunk', handler)

      parser.feed(
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text: 'First' },
              { type: 'text', text: 'Second' },
            ],
          },
        }),
      )

      expect(handler).toHaveBeenCalledTimes(2)
    })
  })

  describe('stream_event', () => {
    it('emits stream_event for content_block_delta', () => {
      const parser = new StreamParser()
      const handler = vi.fn()
      parser.on('stream_event', handler)

      const msg = {
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } },
        session_id: 'sess-1',
        parent_tool_use_id: null,
        uuid: 'uuid-1',
      }
      parser.feed(JSON.stringify(msg))

      expect(handler).toHaveBeenCalledOnce()
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ type: 'stream_event' }))
    })

    it('emits text_delta for content_block_delta with text_delta type', () => {
      const parser = new StreamParser()
      const handler = vi.fn()
      parser.on('text_delta', handler)

      parser.feed(
        JSON.stringify({
          type: 'stream_event',
          event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } },
          session_id: 'sess-1',
        }),
      )

      expect(handler).toHaveBeenCalledOnce()
      expect(handler).toHaveBeenCalledWith({ text: 'hello' })
    })

    it('does not emit text_delta for non-text_delta deltas', () => {
      const parser = new StreamParser()
      const handler = vi.fn()
      parser.on('text_delta', handler)

      parser.feed(
        JSON.stringify({
          type: 'stream_event',
          event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } },
          session_id: 'sess-1',
        }),
      )

      expect(handler).not.toHaveBeenCalled()
    })

    it('emits stream_event for message_start', () => {
      const parser = new StreamParser()
      const handler = vi.fn()
      parser.on('stream_event', handler)

      parser.feed(
        JSON.stringify({
          type: 'stream_event',
          event: { type: 'message_start' },
          session_id: 'sess-1',
        }),
      )

      expect(handler).toHaveBeenCalledOnce()
    })

    it('emits stream_event for content_block_start and content_block_stop', () => {
      const parser = new StreamParser()
      const handler = vi.fn()
      parser.on('stream_event', handler)

      parser.feed(
        JSON.stringify({
          type: 'stream_event',
          event: { type: 'content_block_start', index: 0 },
          session_id: 'sess-1',
        }),
      )
      parser.feed(
        JSON.stringify({
          type: 'stream_event',
          event: { type: 'content_block_stop', index: 0 },
          session_id: 'sess-1',
        }),
      )

      expect(handler).toHaveBeenCalledTimes(2)
    })

    it('emits stream_event for message_stop', () => {
      const parser = new StreamParser()
      const handler = vi.fn()
      parser.on('stream_event', handler)

      parser.feed(
        JSON.stringify({
          type: 'stream_event',
          event: { type: 'message_stop' },
          session_id: 'sess-1',
        }),
      )

      expect(handler).toHaveBeenCalledOnce()
    })
  })

  describe('hook_event', () => {
    it('emits hook_event for hook_started', () => {
      const parser = new StreamParser()
      const handler = vi.fn()
      parser.on('hook_event', handler)

      parser.feed(
        JSON.stringify({
          type: 'system',
          subtype: 'hook_started',
          hook_id: 'hook-1',
          hook_name: 'SessionStart:startup',
          hook_event: 'SessionStart',
        }),
      )

      expect(handler).toHaveBeenCalledOnce()
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ subtype: 'hook_started' }))
    })

    it('emits hook_event for hook_response', () => {
      const parser = new StreamParser()
      const handler = vi.fn()
      parser.on('hook_event', handler)

      parser.feed(
        JSON.stringify({
          type: 'system',
          subtype: 'hook_response',
          hook_id: 'hook-1',
          output: 'done',
          exit_code: 0,
          outcome: 'success',
        }),
      )

      expect(handler).toHaveBeenCalledOnce()
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ subtype: 'hook_response' }))
    })

    it('emits hook_event for hook_progress', () => {
      const parser = new StreamParser()
      const handler = vi.fn()
      parser.on('hook_event', handler)

      parser.feed(
        JSON.stringify({
          type: 'system',
          subtype: 'hook_progress',
          hook_id: 'hook-1',
        }),
      )

      expect(handler).toHaveBeenCalledOnce()
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ subtype: 'hook_progress' }))
    })

    it('does not emit session_id for hook subtypes', () => {
      const parser = new StreamParser()
      const handler = vi.fn()
      parser.on('session_id', handler)

      parser.feed(
        JSON.stringify({ type: 'system', subtype: 'hook_started', hook_id: 'h1' }),
      )

      expect(handler).not.toHaveBeenCalled()
    })
  })

  describe('rate_limit_info', () => {
    it('emits rate_limit_info from rate_limit_event message', () => {
      const parser = new StreamParser()
      const handler = vi.fn()
      parser.on('rate_limit_info', handler)

      parser.feed(
        JSON.stringify({
          type: 'rate_limit_event',
          rate_limit_info: { status: 'allowed', resetsAt: 1775552400 },
        }),
      )

      expect(handler).toHaveBeenCalledOnce()
      expect(handler).toHaveBeenCalledWith({ status: 'allowed', resetsAt: 1775552400 })
    })

    it('does not emit rate_limit_info if rate_limit_info field is missing', () => {
      const parser = new StreamParser()
      const handler = vi.fn()
      parser.on('rate_limit_info', handler)

      parser.feed(JSON.stringify({ type: 'rate_limit_event' }))

      expect(handler).not.toHaveBeenCalled()
    })
  })

  describe('tool_call', () => {
    it('emits tool_call from assistant tool_use block with object input', () => {
      const parser = new StreamParser()
      const handler = vi.fn()
      parser.on('tool_call', handler)

      parser.feed(
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'tool-id-1',
                name: 'bash',
                input: { command: 'ls -la' },
              },
            ],
          },
        }),
      )

      expect(handler).toHaveBeenCalledOnce()
      expect(handler).toHaveBeenCalledWith({
        toolCallId: 'tool-id-1',
        toolName: 'bash',
        toolInput: { command: 'ls -la' },
      })
    })

    it('emits tool_call from assistant tool_use block with string input', () => {
      const parser = new StreamParser()
      const handler = vi.fn()
      parser.on('tool_call', handler)

      parser.feed(
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'tool-id-2',
                name: 'bash',
                input: 'raw string input',
              },
            ],
          },
        }),
      )

      expect(handler).toHaveBeenCalledOnce()
      expect(handler).toHaveBeenCalledWith({
        toolCallId: 'tool-id-2',
        toolName: 'bash',
        toolInput: 'raw string input',
      })
    })
  })

  describe('tool_result', () => {
    it('emits tool_result from assistant tool_result block with string content', () => {
      const parser = new StreamParser()
      const handler = vi.fn()
      parser.on('tool_result', handler)

      parser.feed(
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tool-id-1',
                content: 'file1.txt\nfile2.txt',
              },
            ],
          },
        }),
      )

      expect(handler).toHaveBeenCalledOnce()
      expect(handler).toHaveBeenCalledWith({
        toolCallId: 'tool-id-1',
        result: 'file1.txt\nfile2.txt',
        isError: undefined,
      })
    })

    it('emits tool_result with isError=true when is_error is set', () => {
      const parser = new StreamParser()
      const handler = vi.fn()
      parser.on('tool_result', handler)

      parser.feed(
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tool-id-2',
                content: 'command not found',
                is_error: true,
              },
            ],
          },
        }),
      )

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ isError: true }),
      )
    })

    it('concatenates text blocks in tool_result content array', () => {
      const parser = new StreamParser()
      const handler = vi.fn()
      parser.on('tool_result', handler)

      parser.feed(
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tool-id-3',
                content: [
                  { type: 'text', text: 'Part1' },
                  { type: 'text', text: 'Part2' },
                ],
              },
            ],
          },
        }),
      )

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ result: 'Part1Part2' }),
      )
    })
  })

  describe('permission_request', () => {
    it('emits permission_request from permission_request message', () => {
      const parser = new StreamParser()
      const handler = vi.fn()
      parser.on('permission_request', handler)

      parser.feed(
        JSON.stringify({
          type: 'permission_request',
          permission_id: 'perm-1',
          tool_name: 'bash',
          tool_input: { command: 'rm -rf /' },
        }),
      )

      expect(handler).toHaveBeenCalledOnce()
      expect(handler).toHaveBeenCalledWith({
        permissionId: 'perm-1',
        toolName: 'bash',
        toolInput: { command: 'rm -rf /' },
      })
    })
  })

  describe('turn_end', () => {
    it('emits turn_end on result success', () => {
      const parser = new StreamParser()
      const handler = vi.fn()
      parser.on('turn_end', handler)

      parser.feed(JSON.stringify({ type: 'result', subtype: 'success' }))

      expect(handler).toHaveBeenCalledOnce()
    })

    it('emits turn_end on result error_max_turns', () => {
      const parser = new StreamParser()
      const handler = vi.fn()
      parser.on('turn_end', handler)

      parser.feed(JSON.stringify({ type: 'result', subtype: 'error_max_turns' }))

      expect(handler).toHaveBeenCalledOnce()
    })

    it('emits turn_end with totalCostUsd and usage when present', () => {
      const parser = new StreamParser()
      const handler = vi.fn()
      parser.on('turn_end', handler)

      parser.feed(
        JSON.stringify({
          type: 'result',
          subtype: 'success',
          total_cost_usd: 0.0042,
          usage: { input_tokens: 100, output_tokens: 50 },
          modelUsage: { 'claude-opus-4': { input_tokens: 100, output_tokens: 50 } },
        }),
      )

      expect(handler).toHaveBeenCalledOnce()
      expect(handler).toHaveBeenCalledWith({
        totalCostUsd: 0.0042,
        usage: { input_tokens: 100, output_tokens: 50 },
        modelUsage: { 'claude-opus-4': { input_tokens: 100, output_tokens: 50 } },
      })
    })

    it('emits turn_end with empty payload when cost fields absent', () => {
      const parser = new StreamParser()
      const handler = vi.fn()
      parser.on('turn_end', handler)

      parser.feed(JSON.stringify({ type: 'result', subtype: 'success' }))

      expect(handler).toHaveBeenCalledWith({})
    })
  })

  describe('error', () => {
    it('emits error for invalid JSON', () => {
      const parser = new StreamParser()
      const handler = vi.fn()
      parser.on('error', handler)

      parser.feed('{ not valid json }')

      expect(handler).toHaveBeenCalledOnce()
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Invalid JSON', raw: '{ not valid json }' }),
      )
    })
  })

  describe('rate_limit', () => {
    it('emits rate_limit from rate_limit_error message', () => {
      const parser = new StreamParser()
      const handler = vi.fn()
      parser.on('rate_limit', handler)

      parser.feed(JSON.stringify({ type: 'rate_limit_error', message: 'Too many requests' }))

      expect(handler).toHaveBeenCalledOnce()
      expect(handler).toHaveBeenCalledWith({ message: 'Too many requests' })
    })
  })

  describe('dispose()', () => {
    it('does not emit events after dispose', () => {
      const parser = new StreamParser()
      const handler = vi.fn()
      parser.on('text_chunk', handler)

      parser.dispose()

      parser.feed(
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'After dispose' }] },
        }),
      )

      expect(handler).not.toHaveBeenCalled()
    })

    it('unsubscribe function stops receiving events', () => {
      const parser = new StreamParser()
      const handler = vi.fn()
      const unsubscribe = parser.on('text_chunk', handler)

      unsubscribe()

      parser.feed(
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'After unsubscribe' }] },
        }),
      )

      expect(handler).not.toHaveBeenCalled()
    })

    it('clears all listeners on dispose', () => {
      const parser = new StreamParser()
      const h1 = vi.fn()
      const h2 = vi.fn()
      parser.on('text_chunk', h1)
      parser.on('session_id', h2)

      parser.dispose()

      parser.feed(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'x' }))
      parser.feed(
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Hi' }] },
        }),
      )

      expect(h1).not.toHaveBeenCalled()
      expect(h2).not.toHaveBeenCalled()
    })
  })

  describe('edge cases', () => {
    it('ignores empty lines', () => {
      const parser = new StreamParser()
      const handler = vi.fn()
      parser.on('error', handler)

      parser.feed('')
      parser.feed('   ')

      expect(handler).not.toHaveBeenCalled()
    })

    it('handles assistant message with no content array gracefully', () => {
      const parser = new StreamParser()
      const handler = vi.fn()
      parser.on('error', handler)

      parser.feed(JSON.stringify({ type: 'assistant', message: {} }))

      expect(handler).not.toHaveBeenCalled()
    })
  })
})
