import { describe, it, expect, vi } from 'vitest'
import { Hono } from 'hono'
import { createEventsRouter } from '../events.js'
import type { ProcessSupervisor } from '../../adapters/cli/process-supervisor.js'
import type { CliProcess } from '../../adapters/cli/cli-process.js'
import type { ApprovalBridge } from '../../adapters/hooks/approval-bridge.js'

// ----------- Mock helpers -----------

type ProcessChangeHandler = (agentId: string, process_: unknown) => void
type EventHandler = (data: unknown) => void

function makeMockProcess() {
  const handlers = new Map<string, Set<EventHandler>>()
  return {
    nexusSessionId: null as string | null,
    nexusAgentId: null as string | null,
    on: vi.fn((event: string, handler: EventHandler) => {
      if (!handlers.has(event)) handlers.set(event, new Set())
      handlers.get(event)!.add(handler)
      return () => { handlers.get(event)?.delete(handler) }
    }),
    _emit(event: string, data: unknown) {
      for (const h of handlers.get(event) ?? []) h(data)
    },
  }
}

function makeMockGroup(entries: [string, ReturnType<typeof makeMockProcess>][] = []) {
  const addedHandlers = new Set<ProcessChangeHandler>()
  return {
    listProcessEntries: vi.fn().mockReturnValue(entries),
    onProcessAdded: vi.fn((handler: ProcessChangeHandler) => {
      addedHandlers.add(handler)
      return () => { addedHandlers.delete(handler) }
    }),
  }
}

function makeMockSupervisor(group: ReturnType<typeof makeMockGroup> | undefined) {
  return {
    getGroup: vi.fn().mockReturnValue(group),
  } as unknown as ProcessSupervisor & { getGroup: ReturnType<typeof vi.fn> }
}

function makeMockApprovalBridge() {
  return {
    onPendingAdded: vi.fn().mockReturnValue(() => {}),
  } as unknown as ApprovalBridge
}

function makeApp(supervisor: ProcessSupervisor, approvalBridge = makeMockApprovalBridge()): Hono {
  const router = createEventsRouter(supervisor, approvalBridge)
  const app = new Hono()
  app.route('/', router)
  return app
}

// Safely awaits a Hono app.request() call that may be aborted
async function safeRequest(promise: Response | Promise<Response>): Promise<Response | null> {
  return Promise.resolve(promise).catch(() => null)
}

// ----------- Tests -----------

describe('events router', () => {
  describe('404 when group not found', () => {
    it('returns 404 when supervisor.getGroup() returns undefined', async () => {
      const supervisor = makeMockSupervisor(undefined)
      const app = makeApp(supervisor)

      const res = await app.request('/tmp/test-workspace/events')

      expect(res.status).toBe(404)
      const body = await res.json() as { error: { code: string } }
      expect(body.error.code).toBe('GROUP_NOT_FOUND')
    })
  })

  describe('workspace path restoration', () => {
    it("reconstructs workspace path with leading '/' from route param", async () => {
      const group = makeMockGroup()
      const supervisor = makeMockSupervisor(group)
      const app = makeApp(supervisor)

      const controller = new AbortController()
      const responsePromise = app.request('/some/workspace/events', { signal: controller.signal })
      controller.abort()
      await safeRequest(responsePromise)

      // getGroup must have been called with the full leading-slash path
      expect(supervisor.getGroup).toHaveBeenCalledWith('/some/workspace')
    })
  })

  describe('SSE stream', () => {
    it('responds with text/event-stream content-type for a known group', async () => {
      const group = makeMockGroup()
      const supervisor = makeMockSupervisor(group)
      const app = makeApp(supervisor)

      const controller = new AbortController()
      const responsePromise = app.request('/tmp/workspace/events', { signal: controller.signal })
      controller.abort()

      const res = await safeRequest(responsePromise)
      if (res) {
        expect(res.headers.get('content-type')).toContain('text/event-stream')
      }
    })

    it('subscribes to all existing processes in the group on connect', async () => {
      const mockProcess = makeMockProcess()
      const group = makeMockGroup([['agent-1', mockProcess]])
      const supervisor = makeMockSupervisor(group)
      const app = makeApp(supervisor)

      const controller = new AbortController()
      const responsePromise = app.request('/tmp/ws/events', { signal: controller.signal })
      controller.abort()
      await safeRequest(responsePromise)

      // listProcessEntries is called to subscribe existing processes
      expect(group.listProcessEntries).toHaveBeenCalled()
      // on() should have been called on the mock process for each event type
      expect(mockProcess.on).toHaveBeenCalled()
    })

    it('registers onProcessAdded listener to catch future processes', async () => {
      const group = makeMockGroup()
      const supervisor = makeMockSupervisor(group)
      const app = makeApp(supervisor)

      const controller = new AbortController()
      const responsePromise = app.request('/tmp/ws2/events', { signal: controller.signal })
      controller.abort()
      await safeRequest(responsePromise)

      expect(group.onProcessAdded).toHaveBeenCalled()
    })

    it('calls getGroup with the correct nested workspace path', async () => {
      const group = makeMockGroup()
      const supervisor = makeMockSupervisor(group)
      const app = makeApp(supervisor)

      const controller = new AbortController()
      const responsePromise = app.request('/Users/kih/projects/my-app/events', { signal: controller.signal })
      controller.abort()
      await safeRequest(responsePromise)

      expect(supervisor.getGroup).toHaveBeenCalledWith('/Users/kih/projects/my-app')
    })
  })
})
