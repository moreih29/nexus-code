/**
 * ClaudeCodeHost observe() cleanup 단위 테스트
 *
 * 검증 대상: observe() AsyncGenerator가 종료될 때(client disconnect, break,
 * early return) EventEmitter listener가 모두 unsubscribe되어 누출이 없는지.
 *
 * finally 블록에서 unsub() 배열을 순회하며 모든 핸들러를 제거하는 구현
 * (claude-code-host.ts:213-215)을 보장한다.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ClaudeCodeHost } from '../claude-code-host.js'
import type { ProcessSupervisor } from '../cli/process-supervisor.js'
import type { ApprovalBridge } from '../hooks/approval-bridge.js'
import type { CliProcess } from '../cli/cli-process.js'
import type { WorkspaceGroup } from '../cli/workspace-group.js'

// ---------------------------------------------------------------------------
// Mock helpers — listener-counting CliProcess
// ---------------------------------------------------------------------------

type EventHandler = (data: unknown) => void

/**
 * CliProcess mock that tracks active subscriptions per event.
 * `on()` returns an unsubscribe function; the mock counts active listeners.
 */
function makeMockCliProcess(): CliProcess & {
  _emit: (event: string, data: unknown) => void
  _listenerCount: (event: string) => number
} {
  const listeners = new Map<string, Set<EventHandler>>()

  const on = vi.fn().mockImplementation((event: string, handler: EventHandler) => {
    if (!listeners.has(event)) listeners.set(event, new Set())
    listeners.get(event)!.add(handler)
    // Return an unsubscribe function
    return () => {
      listeners.get(event)?.delete(handler)
    }
  })

  const emit = (event: string, data: unknown) => {
    listeners.get(event)?.forEach((h) => h(data))
  }

  const listenerCount = (event: string) => listeners.get(event)?.size ?? 0

  const process: CliProcess = {
    nexusSessionId: null,
    nexusAgentId: null,
    getStatus: vi.fn().mockReturnValue('idle'),
    isAlive: vi.fn().mockReturnValue(true),
    start: vi.fn().mockImplementation(async () => {
      setTimeout(() => emit('init', { sessionId: 'cli-session-ext' }), 0)
      return { ok: true, value: undefined }
    }),
    sendPrompt: vi.fn().mockReturnValue({ ok: true, value: undefined }),
    cancel: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
    on,
  } as unknown as CliProcess

  const extended = process as typeof process & {
    _emit: typeof emit
    _listenerCount: typeof listenerCount
  }
  extended._emit = emit
  extended._listenerCount = listenerCount

  return extended
}

function makeMockWorkspaceGroup(cliProcess: CliProcess): WorkspaceGroup {
  return {
    workspacePath: '/test/workspace',
    getProcess: vi.fn().mockReturnValue(cliProcess),
    removeProcess: vi.fn(),
    createProcess: vi.fn().mockReturnValue({ ok: true, value: cliProcess }),
    listProcesses: vi.fn().mockReturnValue([cliProcess]),
    listProcessEntries: vi.fn().mockReturnValue([]),
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
    getGroup: vi.fn().mockReturnValue(undefined),
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

describe('ClaudeCodeHost observe() — listener cleanup', () => {
  let cliProcess: ReturnType<typeof makeMockCliProcess>
  let host: ClaudeCodeHost

  beforeEach(() => {
    cliProcess = makeMockCliProcess()
    const supervisor = makeMockProcessSupervisor(cliProcess)
    const bridge = makeMockApprovalBridge()
    host = new ClaudeCodeHost(supervisor, bridge)
  })

  it('registers listeners on observe() start and removes all on session_ended', async () => {
    const spawnResult = await host.spawn({
      harnessType: 'claude-code',
      workingDirectory: '/test/workspace',
    })
    expect(spawnResult.ok).toBe(true)
    if (!spawnResult.ok) return
    const sessionId = spawnResult.value

    // Count total on() registrations before observe starts
    // cliProcess.on is already vi.fn() so we can access .mock directly
    const onFn = cliProcess.on as ReturnType<typeof vi.fn>
    const onCallsBefore = onFn.mock.calls.length

    const iter = host.observe(sessionId)

    // Drive the generator: trigger turn_end to let it complete naturally
    setImmediate(() => {
      cliProcess._emit('turn_end', {})
    })

    for await (const _event of iter) {
      // consume
    }

    // After the generator finishes, on() must have been called (listeners registered)
    expect(onFn.mock.calls.length).toBeGreaterThan(onCallsBefore)

    // All events from the observe() subscription set should be cleared.
    // The mock's unsubscribe functions remove from the Set, so listenerCount should be 0.
    const eventNames = ['text_chunk', 'text_delta', 'tool_call', 'tool_result',
      'permission_request', 'error', 'rate_limit', 'turn_end', 'status_change']
    for (const event of eventNames) {
      expect(cliProcess._listenerCount(event)).toBe(0)
    }
  })

  it('removes all listeners when consumer breaks early (early return from for-await)', async () => {
    const spawnResult = await host.spawn({
      harnessType: 'claude-code',
      workingDirectory: '/test/workspace',
    })
    expect(spawnResult.ok).toBe(true)
    if (!spawnResult.ok) return
    const sessionId = spawnResult.value

    const iter = host.observe(sessionId)

    // Only consume the first event (session_started), then break
    // This triggers the generator's return() / finally block
    for await (const event of iter) {
      expect(event.type).toBe('session_started')
      break
    }

    // After early break, all listeners must be cleaned up
    const eventNames = ['text_chunk', 'text_delta', 'tool_call', 'tool_result',
      'permission_request', 'error', 'rate_limit', 'turn_end', 'status_change']
    for (const event of eventNames) {
      expect(cliProcess._listenerCount(event)).toBe(0)
    }
  })

  it('removes all listeners when generator return() is called explicitly', async () => {
    const spawnResult = await host.spawn({
      harnessType: 'claude-code',
      workingDirectory: '/test/workspace',
    })
    expect(spawnResult.ok).toBe(true)
    if (!spawnResult.ok) return
    const sessionId = spawnResult.value

    const gen = host.observe(sessionId) as AsyncGenerator<unknown>

    // Advance to get session_started
    await gen.next()

    // Call return() explicitly — simulates client disconnect
    await gen.return(undefined)

    // All listeners must be removed
    const eventNames = ['text_chunk', 'text_delta', 'tool_call', 'tool_result',
      'permission_request', 'error', 'rate_limit', 'turn_end', 'status_change']
    for (const event of eventNames) {
      expect(cliProcess._listenerCount(event)).toBe(0)
    }
  })

  it('emits permission_asked and removes its listener after session ends', async () => {
    const spawnResult = await host.spawn({
      harnessType: 'claude-code',
      workingDirectory: '/test/workspace',
    })
    expect(spawnResult.ok).toBe(true)
    if (!spawnResult.ok) return
    const sessionId = spawnResult.value

    const iter = host.observe(sessionId)
    const events: unknown[] = []

    setImmediate(() => {
      cliProcess._emit('permission_request', {
        permissionId: 'perm-cleanup-test',
        toolName: 'Write',
        toolInput: { path: '/tmp/x' },
      })
      cliProcess._emit('status_change', { status: 'stopped' })
    })

    for await (const event of iter) {
      events.push(event)
    }

    const permEvent = events.find((e) => (e as { type: string }).type === 'permission_asked')
    expect(permEvent).toBeDefined()

    // After generator completes, permission_request listener must be gone
    expect(cliProcess._listenerCount('permission_request')).toBe(0)
  })
})
