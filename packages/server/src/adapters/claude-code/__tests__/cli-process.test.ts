import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { Writable, Readable } from 'node:stream'

// --- Mock child_process ---
const mockChildProcess = {
  stdin: null as Writable | null,
  stdout: null as Readable | null,
  stderr: null as Readable | null,
  emitter: new EventEmitter(),
  kill: vi.fn(),
  on(event: string, handler: (...args: unknown[]) => void) {
    this.emitter.on(event, handler)
    return this
  },
  once(event: string, handler: (...args: unknown[]) => void) {
    this.emitter.once(event, handler)
    return this
  },
}

function makeMockChild() {
  const stdin = new Writable({ write(_chunk, _enc, cb) { cb() } })
  const stdout = new Readable({ read() {} })
  const stderr = new Readable({ read() {} })

  const child = new EventEmitter() as EventEmitter & {
    stdin: Writable
    stdout: Readable
    stderr: Readable
    kill: ReturnType<typeof vi.fn>
  }
  child.stdin = stdin
  child.stdout = stdout
  child.stderr = stderr
  child.kill = vi.fn()

  return child
}

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}))

import { spawn } from 'node:child_process'
import { CliProcess } from '../cli-process.js'

const mockSpawn = vi.mocked(spawn)

describe('CliProcess', () => {
  let process_: CliProcess
  let child: ReturnType<typeof makeMockChild>

  beforeEach(() => {
    process_ = new CliProcess()
    child = makeMockChild()
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>)
  })

  afterEach(() => {
    process_.dispose()
    vi.clearAllMocks()
  })

  describe('initial state', () => {
    it('starts in idle state', () => {
      expect(process_.getStatus()).toBe('idle')
    })
  })

  describe('start()', () => {
    it('transitions to running after successful start', async () => {
      const result = await process_.start({ prompt: 'Hello', cwd: '/tmp' })
      expect(result.ok).toBe(true)
      expect(process_.getStatus()).toBe('running')
    })

    it('passes the initial prompt to stdin as JSON', async () => {
      const writes: string[] = []
      child.stdin._write = (chunk: Buffer, _enc: string, cb: () => void) => {
        writes.push(chunk.toString())
        cb()
      }

      await process_.start({ prompt: 'Test prompt', cwd: '/tmp' })

      expect(writes.length).toBeGreaterThan(0)
      const parsed = JSON.parse(writes[0].trim()) as { type: string; message: { role: string; content: string }; parent_tool_use_id: null; session_id: string }
      expect(parsed.type).toBe('user')
      expect(parsed.message.role).toBe('user')
      expect(parsed.message.content).toBe('Test prompt')
      expect(parsed.parent_tool_use_id).toBeNull()
    })

    it('returns error when process is already running', async () => {
      await process_.start({ prompt: 'First', cwd: '/tmp' })
      const result = await process_.start({ prompt: 'Second', cwd: '/tmp' })
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.code).toBe('CLI_ALREADY_RUNNING')
      }
    })

    it('emits status_change events during start', async () => {
      const statuses: string[] = []
      process_.on('status_change', ({ status }) => statuses.push(status))

      await process_.start({ prompt: 'Hello', cwd: '/tmp' })

      expect(statuses).toContain('starting')
      expect(statuses).toContain('running')
    })

    it('transitions to error when spawn throws', async () => {
      mockSpawn.mockImplementationOnce(() => {
        throw new Error('spawn ENOENT')
      })

      const result = await process_.start({ prompt: 'Hello', cwd: '/tmp' })
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.code).toBe('CLI_SPAWN_FAILED')
      }
      expect(process_.getStatus()).toBe('error')
    })

    it('transitions to error when stdin is closed', async () => {
      child.stdin.destroy()

      const result = await process_.start({ prompt: 'Hello', cwd: '/tmp' })
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.code).toBe('CLI_STDIN_CLOSED')
      }
      expect(process_.getStatus()).toBe('error')
    })

    it('includes --include-partial-messages in spawn args', async () => {
      await process_.start({ prompt: 'Hello', cwd: '/tmp' })

      const [, args] = mockSpawn.mock.calls[0] as [string, string[], unknown]
      expect(args).toContain('--include-partial-messages')
    })

    it('includes --max-turns when maxTurns option is provided', async () => {
      await process_.start({ prompt: 'Hello', cwd: '/tmp', maxTurns: 5 })

      const [, args] = mockSpawn.mock.calls[0] as [string, string[], unknown]
      const idx = args.indexOf('--max-turns')
      expect(idx).toBeGreaterThan(-1)
      expect(args[idx + 1]).toBe('5')
    })

    it('does not include --max-turns when maxTurns is not provided', async () => {
      await process_.start({ prompt: 'Hello', cwd: '/tmp' })

      const [, args] = mockSpawn.mock.calls[0] as [string, string[], unknown]
      expect(args).not.toContain('--max-turns')
    })

    it('includes --continue when continueSession is true', async () => {
      await process_.start({ prompt: 'Hello', cwd: '/tmp', continueSession: true })

      const [, args] = mockSpawn.mock.calls[0] as [string, string[], unknown]
      expect(args).toContain('--continue')
    })

    it('does not include --continue when continueSession is false or absent', async () => {
      await process_.start({ prompt: 'Hello', cwd: '/tmp' })

      const [, args] = mockSpawn.mock.calls[0] as [string, string[], unknown]
      expect(args).not.toContain('--continue')
    })

    it('includes --effort flag when effortLevel is provided', async () => {
      await process_.start({ prompt: 'Hello', cwd: '/tmp', effortLevel: 'high' })

      const [, args] = mockSpawn.mock.calls[0] as [string, string[], unknown]
      const idx = args.indexOf('--effort')
      expect(idx).toBeGreaterThan(-1)
      expect(args[idx + 1]).toBe('high')
    })

    it('does not include --effort when effortLevel is not provided', async () => {
      await process_.start({ prompt: 'Hello', cwd: '/tmp' })

      const [, args] = mockSpawn.mock.calls[0] as [string, string[], unknown]
      expect(args).not.toContain('--effort')
    })
  })

  describe('sendPrompt()', () => {
    it('sends a message to stdin as JSON', async () => {
      const writes: string[] = []
      let callCount = 0
      child.stdin._write = (chunk: Buffer, _enc: string, cb: () => void) => {
        if (callCount > 0) writes.push(chunk.toString()) // skip initial prompt
        callCount++
        cb()
      }

      await process_.start({ prompt: 'First', cwd: '/tmp' })
      const result = process_.sendPrompt('Follow-up')

      expect(result.ok).toBe(true)
      expect(writes.length).toBeGreaterThan(0)
      const lastWrite = writes[writes.length - 1]
      const parsed = JSON.parse(lastWrite.trim()) as { type: string; message: { role: string; content: string } }
      expect(parsed.message.role).toBe('user')
      expect(parsed.message.content).toBe('Follow-up')
    })

    it('returns error when not running', () => {
      const result = process_.sendPrompt('Hello')
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.code).toBe('CLI_NOT_RUNNING')
      }
    })

    it('propagates stdin write failure', async () => {
      await process_.start({ prompt: 'Hello', cwd: '/tmp' })
      child.stdin.destroy()

      const result = process_.sendPrompt('After destroy')
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.code).toBe('CLI_STDIN_CLOSED')
      }
    })
  })

  describe('status transitions from parser events', () => {
    it('transitions to waiting_permission on permission_request', async () => {
      await process_.start({ prompt: 'Hello', cwd: '/tmp' })

      child.stdout.push(
        JSON.stringify({
          type: 'permission_request',
          permission_id: 'perm-1',
          tool_name: 'bash',
          tool_input: { command: 'ls' },
        }) + '\n',
      )

      await new Promise((r) => setTimeout(r, 10))
      expect(process_.getStatus()).toBe('waiting_permission')
    })

    it('transitions to idle on turn_end', async () => {
      await process_.start({ prompt: 'Hello', cwd: '/tmp' })

      child.stdout.push(JSON.stringify({ type: 'result', subtype: 'success' }) + '\n')

      await new Promise((r) => setTimeout(r, 10))
      expect(process_.getStatus()).toBe('idle')
    })

    it('transitions to stopped when process exits with code 0', async () => {
      await process_.start({ prompt: 'Hello', cwd: '/tmp' })
      child.emit('exit', 0)

      expect(process_.getStatus()).toBe('stopped')
    })

    it('transitions to error when process exits with non-zero code', async () => {
      await process_.start({ prompt: 'Hello', cwd: '/tmp' })
      child.emit('exit', 1)

      expect(process_.getStatus()).toBe('error')
    })
  })

  describe('dispose()', () => {
    it('kills the process on dispose', async () => {
      await process_.start({ prompt: 'Hello', cwd: '/tmp' })
      process_.dispose()

      expect(child.kill).toHaveBeenCalled()
    })

    it('releases all listeners on dispose', async () => {
      await process_.start({ prompt: 'Hello', cwd: '/tmp' })

      const handler = vi.fn()
      process_.on('text_chunk', handler)
      process_.dispose()

      child.stdout.push(
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'After dispose' }] },
        }) + '\n',
      )

      await new Promise((r) => setTimeout(r, 10))
      expect(handler).not.toHaveBeenCalled()
    })

    it('can be called multiple times without error', async () => {
      await process_.start({ prompt: 'Hello', cwd: '/tmp' })
      expect(() => {
        process_.dispose()
        process_.dispose()
      }).not.toThrow()
    })
  })

  describe('on() returns unsubscribe function', () => {
    it('stops receiving events after unsubscribe', async () => {
      await process_.start({ prompt: 'Hello', cwd: '/tmp' })

      const handler = vi.fn()
      const unsubscribe = process_.on('text_chunk', handler)
      unsubscribe()

      child.stdout.push(
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Hello' }] },
        }) + '\n',
      )

      await new Promise((r) => setTimeout(r, 10))
      expect(handler).not.toHaveBeenCalled()
    })
  })

  describe('isAlive()', () => {
    it('returns false when process has not started', () => {
      expect(process_.isAlive()).toBe(false)
    })

    it('returns false when process is in stopped state', async () => {
      await process_.start({ prompt: 'Hello', cwd: '/tmp' })
      child.emit('exit', 0)
      expect(process_.isAlive()).toBe(false)
    })

    it('returns false when process is in error state', async () => {
      await process_.start({ prompt: 'Hello', cwd: '/tmp' })
      child.emit('exit', 1)
      expect(process_.isAlive()).toBe(false)
    })

    it('returns true when process is running and pid is accessible', async () => {
      Object.defineProperty(child, 'pid', { value: process.pid, writable: true })
      await process_.start({ prompt: 'Hello', cwd: '/tmp' })
      // process.pid is our own pid — signal 0 succeeds
      expect(process_.isAlive()).toBe(true)
    })

    it('returns false when process pid is not alive', async () => {
      // Use a pid that is very unlikely to exist
      Object.defineProperty(child, 'pid', { value: 2147483647, writable: true })
      await process_.start({ prompt: 'Hello', cwd: '/tmp' })
      expect(process_.isAlive()).toBe(false)
    })
  })
})
