import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ClaudeCodeHost } from '../claude-code-host.js'
import type { ProcessSupervisor } from '../cli/process-supervisor.js'
import type { ApprovalBridge } from '../hooks/approval-bridge.js'
import type { CliProcess } from '../cli/cli-process.js'
import type { WorkspaceGroup } from '../cli/workspace-group.js'

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

type EventHandler = (data: unknown) => void

function makeMockCliProcess(overrides: Partial<CliProcess> = {}): CliProcess {
  const listeners = new Map<string, Set<EventHandler>>()

  const on = vi.fn().mockImplementation((event: string, handler: EventHandler) => {
    if (!listeners.has(event)) listeners.set(event, new Set())
    listeners.get(event)!.add(handler)
    return () => { listeners.get(event)?.delete(handler) }
  })

  const emit = (event: string, data: unknown) => {
    listeners.get(event)?.forEach((h) => h(data))
  }

  const process: CliProcess = {
    nexusSessionId: null,
    nexusAgentId: null,
    getStatus: vi.fn().mockReturnValue('idle'),
    isAlive: vi.fn().mockReturnValue(true),
    start: vi.fn().mockImplementation(async () => {
      // Simulate the 'init' event firing after start
      setTimeout(() => emit('init', { sessionId: 'cli-external-session-id' }), 0)
      return { ok: true, value: undefined }
    }),
    sendPrompt: vi.fn().mockReturnValue({ ok: true, value: undefined }),
    cancel: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
    on,
    ...overrides,
  } as unknown as CliProcess

  // Attach emit helper for tests to trigger events
  ;(process as unknown as { _emit: typeof emit })._emit = emit

  return process
}

function makeMockWorkspaceGroup(cliProcess: CliProcess): WorkspaceGroup {
  return {
    workspacePath: '/test/workspace',
    getProcess: vi.fn().mockReturnValue(cliProcess),
    removeProcess: vi.fn(),
    createProcess: vi.fn().mockReturnValue({ ok: true, value: cliProcess }),
    listProcesses: vi.fn().mockReturnValue([cliProcess]),
    listProcessEntries: vi.fn().mockReturnValue([['session-id', cliProcess]]),
    getProcessCount: vi.fn().mockReturnValue(1),
    onProcessAdded: vi.fn().mockReturnValue(() => {}),
    onProcessRemoved: vi.fn().mockReturnValue(() => {}),
    dispose: vi.fn(),
  } as unknown as WorkspaceGroup
}

function makeMockProcessSupervisor(cliProcess: CliProcess): ProcessSupervisor {
  const group = makeMockWorkspaceGroup(cliProcess)

  return {
    createGroup: vi.fn().mockReturnValue({ ok: true, value: group }),
    getGroup: vi.fn().mockReturnValue(undefined), // default: no group yet
    removeGroup: vi.fn(),
    createProcessInGroup: vi.fn().mockReturnValue({ ok: true, value: cliProcess }),
    listGroups: vi.fn().mockReturnValue([group]),
    getGlobalProcessCount: vi.fn().mockReturnValue(0),
    isGlobalLimitReached: vi.fn().mockReturnValue(false),
    dispose: vi.fn(),
  } as unknown as ProcessSupervisor
}

function makeMockApprovalBridge(): ApprovalBridge {
  return {
    respond: vi.fn().mockReturnValue(true),
    addPending: vi.fn().mockResolvedValue('allow'),
    listPending: vi.fn().mockReturnValue([]),
    onPendingAdded: vi.fn().mockReturnValue(() => {}),
    onPendingSettled: vi.fn().mockReturnValue(() => {}),
  } as unknown as ApprovalBridge
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ClaudeCodeHost', () => {
  let cliProcess: CliProcess & { _emit: (event: string, data: unknown) => void }
  let supervisor: ProcessSupervisor
  let bridge: ApprovalBridge
  let host: ClaudeCodeHost

  beforeEach(() => {
    cliProcess = makeMockCliProcess() as CliProcess & { _emit: (event: string, data: unknown) => void }
    supervisor = makeMockProcessSupervisor(cliProcess)
    bridge = makeMockApprovalBridge()
    host = new ClaudeCodeHost(supervisor, bridge)
  })

  // -------------------------------------------------------------------------
  // spawn
  // -------------------------------------------------------------------------

  describe('spawn()', () => {
    it('returns ok with a nexusSessionId string', async () => {
      const result = await host.spawn({
        harnessType: 'claude-code',
        workingDirectory: '/test/workspace',
      })

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(typeof result.value).toBe('string')
        expect(result.value.length).toBeGreaterThan(0)
      }
    })

    it('calls createGroup when group does not exist', async () => {
      await host.spawn({
        harnessType: 'claude-code',
        workingDirectory: '/test/workspace',
      })

      expect(supervisor.createGroup).toHaveBeenCalledWith('/test/workspace')
    })

    it('skips createGroup when group already exists', async () => {
      const group = makeMockWorkspaceGroup(cliProcess)
      vi.mocked(supervisor.getGroup).mockReturnValue(group)

      await host.spawn({
        harnessType: 'claude-code',
        workingDirectory: '/test/workspace',
      })

      expect(supervisor.createGroup).not.toHaveBeenCalled()
    })

    it('calls cliProcess.start with model option', async () => {
      await host.spawn({
        harnessType: 'claude-code',
        workingDirectory: '/test/workspace',
        model: 'claude-opus-4-5',
      })

      expect(cliProcess.start).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'claude-opus-4-5' }),
      )
    })

    it('passes resumeSessionId as sessionId to start', async () => {
      await host.spawn({
        harnessType: 'claude-code',
        workingDirectory: '/test/workspace',
        resumeSessionId: 'external-cli-session-123',
      })

      expect(cliProcess.start).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'external-cli-session-123' }),
      )
    })

    it('passes continueSession to start', async () => {
      await host.spawn({
        harnessType: 'claude-code',
        workingDirectory: '/test/workspace',
        continueSession: true,
      })

      expect(cliProcess.start).toHaveBeenCalledWith(
        expect.objectContaining({ continueSession: true }),
      )
    })

    it('returns err when createProcessInGroup fails', async () => {
      vi.mocked(supervisor.createProcessInGroup).mockReturnValue({
        ok: false,
        error: { code: 'GLOBAL_PROCESS_LIMIT', message: 'limit reached', severity: 'recoverable' },
      })

      const result = await host.spawn({
        harnessType: 'claude-code',
        workingDirectory: '/test/workspace',
      })

      expect(result.ok).toBe(false)
    })

    it('returns err when cliProcess.start fails', async () => {
      vi.mocked(cliProcess.start).mockResolvedValue({
        ok: false,
        error: { code: 'CLI_SPAWN_FAILED', message: 'spawn failed', severity: 'fatal' },
      })

      const result = await host.spawn({
        harnessType: 'claude-code',
        workingDirectory: '/test/workspace',
      })

      expect(result.ok).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // observe
  // -------------------------------------------------------------------------

  describe('observe()', () => {
    it('yields session_started as the first event', async () => {
      const spawnResult = await host.spawn({
        harnessType: 'claude-code',
        workingDirectory: '/test/workspace',
      })
      expect(spawnResult.ok).toBe(true)
      if (!spawnResult.ok) return

      const sessionId = spawnResult.value
      const iter = host.observe(sessionId)

      // Trigger session end so the generator completes
      setImmediate(() => cliProcess._emit('status_change', { status: 'stopped' }))

      const events = []
      for await (const event of iter) {
        events.push(event)
      }

      expect(events[0]).toEqual({ type: 'session_started', sessionId, harnessType: 'claude-code' })
    })

    it('yields message event for text_chunk', async () => {
      const spawnResult = await host.spawn({
        harnessType: 'claude-code',
        workingDirectory: '/test/workspace',
      })
      if (!spawnResult.ok) return
      const sessionId = spawnResult.value

      const iter = host.observe(sessionId)

      setImmediate(() => {
        cliProcess._emit('text_chunk', { text: 'Hello world' })
        cliProcess._emit('status_change', { status: 'stopped' })
      })

      const events = []
      for await (const event of iter) {
        events.push(event)
      }

      const msgEvent = events.find((e) => e.type === 'message')
      expect(msgEvent).toEqual({
        type: 'message',
        sessionId,
        role: 'assistant',
        content: 'Hello world',
      })
    })

    it('yields tool_call event', async () => {
      const spawnResult = await host.spawn({
        harnessType: 'claude-code',
        workingDirectory: '/test/workspace',
      })
      if (!spawnResult.ok) return
      const sessionId = spawnResult.value

      const iter = host.observe(sessionId)

      setImmediate(() => {
        cliProcess._emit('tool_call', {
          toolCallId: 'tc-1',
          toolName: 'Bash',
          toolInput: { command: 'ls' },
        })
        cliProcess._emit('status_change', { status: 'stopped' })
      })

      const events = []
      for await (const event of iter) {
        events.push(event)
      }

      const toolEvent = events.find((e) => e.type === 'tool_call')
      expect(toolEvent).toEqual({
        type: 'tool_call',
        sessionId,
        toolName: 'Bash',
        input: { command: 'ls' },
      })
    })

    it('yields permission_asked event for permission_request', async () => {
      const spawnResult = await host.spawn({
        harnessType: 'claude-code',
        workingDirectory: '/test/workspace',
      })
      if (!spawnResult.ok) return
      const sessionId = spawnResult.value

      const iter = host.observe(sessionId)

      setImmediate(() => {
        cliProcess._emit('permission_request', {
          permissionId: 'perm-001',
          toolName: 'Write',
          toolInput: { file_path: '/tmp/test.txt', content: 'hi' },
        })
        cliProcess._emit('status_change', { status: 'stopped' })
      })

      const events = []
      for await (const event of iter) {
        events.push(event)
      }

      const permEvent = events.find((e) => e.type === 'permission_asked')
      expect(permEvent).toEqual({
        type: 'permission_asked',
        sessionId,
        permissionId: 'perm-001',
        toolName: 'Write',
        input: { file_path: '/tmp/test.txt', content: 'hi' },
      })
    })

    it('yields session_ended for turn_end', async () => {
      const spawnResult = await host.spawn({
        harnessType: 'claude-code',
        workingDirectory: '/test/workspace',
      })
      if (!spawnResult.ok) return
      const sessionId = spawnResult.value

      const iter = host.observe(sessionId)

      setImmediate(() => {
        cliProcess._emit('turn_end', {})
      })

      const events = []
      for await (const event of iter) {
        events.push(event)
      }

      const endEvent = events.find((e) => e.type === 'session_ended')
      expect(endEvent).toEqual({ type: 'session_ended', sessionId, exitCode: 0 })
    })

    it('returns immediately for unknown sessionId', async () => {
      const iter = host.observe('unknown-session-id')
      const events = []
      for await (const event of iter) {
        events.push(event)
      }
      expect(events).toHaveLength(0)
    })
  })

  // -------------------------------------------------------------------------
  // approve / reject
  // -------------------------------------------------------------------------

  describe('approve()', () => {
    it('calls approvalBridge.respond with allow', async () => {
      const result = await host.approve('perm-001', { allow: true })
      expect(result.ok).toBe(true)
      expect(bridge.respond).toHaveBeenCalledWith('perm-001', 'allow')
    })

    it('calls approvalBridge.respond with deny when allow=false', async () => {
      const result = await host.approve('perm-001', { allow: false })
      expect(result.ok).toBe(true)
      expect(bridge.respond).toHaveBeenCalledWith('perm-001', 'deny')
    })
  })

  describe('reject()', () => {
    it('calls approvalBridge.respond with deny', async () => {
      const result = await host.reject('perm-001', 'not allowed')
      expect(result.ok).toBe(true)
      expect(bridge.respond).toHaveBeenCalledWith('perm-001', 'deny')
    })
  })

  // -------------------------------------------------------------------------
  // dispose
  // -------------------------------------------------------------------------

  describe('dispose()', () => {
    it('returns err for unknown sessionId', async () => {
      const result = await host.dispose('nonexistent-session')
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.code).toBe('SESSION_NOT_FOUND')
      }
    })

    it('cancels and disposes cliProcess for known session', async () => {
      const spawnResult = await host.spawn({
        harnessType: 'claude-code',
        workingDirectory: '/test/workspace',
      })
      if (!spawnResult.ok) return
      const sessionId = spawnResult.value

      const result = await host.dispose(sessionId)

      expect(result.ok).toBe(true)
      expect(cliProcess.cancel).toHaveBeenCalled()
      expect(cliProcess.dispose).toHaveBeenCalled()
    })

    it('removes session from internal map after dispose', async () => {
      const spawnResult = await host.spawn({
        harnessType: 'claude-code',
        workingDirectory: '/test/workspace',
      })
      if (!spawnResult.ok) return
      const sessionId = spawnResult.value

      await host.dispose(sessionId)

      // Second dispose should fail — session no longer tracked
      const result2 = await host.dispose(sessionId)
      expect(result2.ok).toBe(false)
    })
  })
})
