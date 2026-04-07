import { describe, it, expect, vi } from 'vitest'
import { StreamParser } from '../stream-parser.js'

describe('StreamParser', () => {
  describe('session_id', () => {
    it('emits session_id from system init message', () => {
      const parser = new StreamParser()
      const handler = vi.fn()
      parser.on('session_id', handler)

      parser.feed(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'abc-123' }))

      expect(handler).toHaveBeenCalledOnce()
      expect(handler).toHaveBeenCalledWith({ sessionId: 'abc-123' })
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

  describe('tool_call', () => {
    it('emits tool_call from assistant tool_use block', () => {
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
