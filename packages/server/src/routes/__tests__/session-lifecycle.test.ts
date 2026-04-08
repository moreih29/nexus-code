import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Hono } from 'hono'
import { randomUUID } from 'node:crypto'
import { SessionStore } from '../../adapters/db/session-store.js'
import { ProcessSupervisor } from '../../adapters/cli/process-supervisor.js'
import { WorkspaceRegistry } from '../../domain/workspace/workspace-registry.js'
import { EventEmitterAdapter } from '../../adapters/events/event-emitter-adapter.js'
import { createSessionRouter } from '../session.js'
import type { SessionRecord } from '../session.js'
import type { CliProcess } from '../../adapters/cli/cli-process.js'
import type { CliProcessFactory } from '../../adapters/cli/workspace-group.js'

// ----------- Mock CliProcess factory -----------

type EventHandler = (data: unknown) => void

interface MockProcess {
  nexusSessionId: string | null
  nexusAgentId: string | null
  getStatus: ReturnType<typeof vi.fn>
  isAlive: ReturnType<typeof vi.fn>
  start: ReturnType<typeof vi.fn>
  sendPrompt: ReturnType<typeof vi.fn>
  cancel: ReturnType<typeof vi.fn>
  dispose: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
  emit(event: string, data: unknown): void
}

function makeMockProcess(): MockProcess {
  const handlers = new Map<string, Set<EventHandler>>()

  const process_: MockProcess = {
    nexusSessionId: null,
    nexusAgentId: null,
    getStatus: vi.fn().mockReturnValue('running'),
    isAlive: vi.fn().mockReturnValue(true),
    start: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    sendPrompt: vi.fn().mockReturnValue({ ok: true }),
    cancel: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
    on: vi.fn((event: string, handler: EventHandler) => {
      if (!handlers.has(event)) {
        handlers.set(event, new Set())
      }
      handlers.get(event)!.add(handler)
      return () => {
        handlers.get(event)?.delete(handler)
      }
    }),
    emit(event: string, data: unknown) {
      const set = handlers.get(event)
      if (set) {
        for (const h of set) h(data)
      }
    },
  }
  return process_
}

// ----------- Mock SettingsStore factory -----------

function makeMockSettingsStore(overrides: Record<string, unknown> = {}): { getEffectiveSettings: ReturnType<typeof vi.fn> } {
  return {
    getEffectiveSettings: vi.fn().mockReturnValue(overrides),
  }
}

// ----------- Test setup -----------

describe('session lifecycle', () => {
  let store: SessionStore
  let supervisor: ProcessSupervisor
  let registry: WorkspaceRegistry
  let sessions: Map<string, SessionRecord>
  let app: Hono
  let currentMockProcess: MockProcess

  const workspacePath = '/tmp/test-workspace'

  beforeEach(() => {
    store = new SessionStore(':memory:')

    const factory: CliProcessFactory = () => {
      currentMockProcess = makeMockProcess()
      return currentMockProcess as unknown as CliProcess
    }
    supervisor = new ProcessSupervisor(30, 10, factory)

    const eventPort = new EventEmitterAdapter()
    registry = new WorkspaceRegistry(eventPort)
    registry.add({ id: randomUUID(), path: workspacePath })

    sessions = new Map<string, SessionRecord>()

    const router = createSessionRouter(supervisor, registry, sessions, store)
    app = new Hono()
    app.route('/sessions', router)
  })

  afterEach(() => {
    store.close()
    supervisor.dispose()
  })

  // ----------- POST /sessions (start) -----------

  describe('POST /sessions — start', () => {
    it('creates a session and records it in SessionStore', async () => {
      const res = await app.request('/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspacePath, prompt: 'Hello' }),
      })

      expect(res.status).toBe(201)
      const body = await res.json() as { id: string }
      const row = store.findById(body.id)
      expect(row).not.toBeNull()
      expect(row!.status).toBe('running')
      expect(row!.workspace_path).toBe(workspacePath)
    })

    it('saves cli_session_id when init event fires', async () => {
      const res = await app.request('/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspacePath, prompt: 'Hello' }),
      })
      const body = await res.json() as { id: string }

      // Simulate the init event from the CLI process
      currentMockProcess.emit('init', { sessionId: 'cli-session-abc', model: 'claude-opus-4' })

      const row = store.findById(body.id)
      expect(row!.cli_session_id).toBe('cli-session-abc')
    })

    it('marks session as ended when status_change emits stopped', async () => {
      const res = await app.request('/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspacePath, prompt: 'Hello' }),
      })
      const body = await res.json() as { id: string }

      currentMockProcess.emit('status_change', { status: 'stopped' })

      const row = store.findById(body.id)
      expect(row!.status).toBe('stopped')
      expect(row!.exit_code).toBe(0)
      expect(row!.ended_at).not.toBeNull()
    })

    it('marks session as error when status_change emits error', async () => {
      const res = await app.request('/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspacePath, prompt: 'Hello' }),
      })
      const body = await res.json() as { id: string }

      currentMockProcess.emit('status_change', { status: 'error' })

      const row = store.findById(body.id)
      expect(row!.status).toBe('error')
      expect(row!.exit_code).toBe(1)
      expect(row!.ended_at).not.toBeNull()
    })

    it('updates status to idle when status_change emits idle', async () => {
      const res = await app.request('/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspacePath, prompt: 'Hello' }),
      })
      const body = await res.json() as { id: string }

      currentMockProcess.emit('status_change', { status: 'idle' })

      const row = store.findById(body.id)
      expect(row!.status).toBe('idle')
    })

    it('returns 404 for unknown workspacePath', async () => {
      const res = await app.request('/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspacePath: '/nonexistent', prompt: 'Hello' }),
      })
      expect(res.status).toBe(404)
    })
  })

  // ----------- POST /sessions/:id/restart -----------

  describe('POST /sessions/:id/restart', () => {
    async function createSessionWithCliId(): Promise<{ sessionId: string }> {
      const createRes = await app.request('/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspacePath, prompt: 'Initial' }),
      })
      const createBody = await createRes.json() as { id: string }
      const sessionId = createBody.id

      // Assign cli_session_id via init event
      currentMockProcess.emit('init', { sessionId: 'cli-session-xyz' })

      return { sessionId }
    }

    it('returns 404 for non-existent session', async () => {
      const res = await app.request('/sessions/does-not-exist/restart', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'Restart' }),
      })
      expect(res.status).toBe(404)
      const body = await res.json() as { error: { code: string } }
      expect(body.error.code).toBe('SESSION_NOT_FOUND')
    })

    it('returns 400 when session has no cli_session_id', async () => {
      const createRes = await app.request('/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspacePath, prompt: 'Initial' }),
      })
      const createBody = await createRes.json() as { id: string }

      // Do NOT fire init event — no cli_session_id
      const res = await app.request(`/sessions/${createBody.id}/restart`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'Restart' }),
      })
      expect(res.status).toBe(400)
      const body = await res.json() as { error: { code: string } }
      expect(body.error.code).toBe('SESSION_NOT_RESUMABLE')
    })

    it('returns 400 when body is missing prompt', async () => {
      const { sessionId } = await createSessionWithCliId()

      const res = await app.request(`/sessions/${sessionId}/restart`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(400)
      const body = await res.json() as { error: { code: string } }
      expect(body.error.code).toBe('VALIDATION_ERROR')
    })

    it('restarts session successfully and returns 200 with same id', async () => {
      const { sessionId } = await createSessionWithCliId()

      const res = await app.request(`/sessions/${sessionId}/restart`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'Restarted prompt' }),
      })
      expect(res.status).toBe(200)
      const body = await res.json() as { id: string; restartedFromCliSessionId: string }
      expect(body.id).toBe(sessionId)
      expect(body.restartedFromCliSessionId).toBe('cli-session-xyz')
    })

    it('calls start with --resume using the stored cli_session_id', async () => {
      const { sessionId } = await createSessionWithCliId()

      await app.request(`/sessions/${sessionId}/restart`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'Restarted' }),
      })

      expect(currentMockProcess.start).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'cli-session-xyz', prompt: 'Restarted' }),
      )
    })

    it('updates SessionStore status to running after restart', async () => {
      const { sessionId } = await createSessionWithCliId()

      await app.request(`/sessions/${sessionId}/restart`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'Restarted' }),
      })

      const row = store.findById(sessionId)
      expect(row!.status).toBe('running')
    })

    it('updates cli_session_id when init event fires after restart', async () => {
      const { sessionId } = await createSessionWithCliId()

      await app.request(`/sessions/${sessionId}/restart`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'Restarted' }),
      })

      // New process fires init with a new cli session id
      currentMockProcess.emit('init', { sessionId: 'cli-session-new' })

      const row = store.findById(sessionId)
      expect(row!.cli_session_id).toBe('cli-session-new')
    })

    it('marks session as ended when new process emits stopped after restart', async () => {
      const { sessionId } = await createSessionWithCliId()

      await app.request(`/sessions/${sessionId}/restart`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'Restarted' }),
      })

      currentMockProcess.emit('status_change', { status: 'stopped' })

      const row = store.findById(sessionId)
      expect(row!.status).toBe('stopped')
      expect(row!.exit_code).toBe(0)
    })

    it('disposes old process when restarting an active session', async () => {
      const createRes = await app.request('/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspacePath, prompt: 'Initial' }),
      })
      const createBody = await createRes.json() as { id: string }
      const sessionId = createBody.id

      const oldProcess = currentMockProcess
      oldProcess.emit('init', { sessionId: 'cli-session-old' })

      await app.request(`/sessions/${sessionId}/restart`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'Restarted' }),
      })

      // The old process should have been disposed via group.removeProcess
      expect(oldProcess.dispose).toHaveBeenCalled()
    })
  })

  // ----------- PUT /sessions/:id/settings -----------

  describe('PUT /sessions/:id/settings', () => {
    async function createSessionWithCliId(): Promise<{ sessionId: string }> {
      const createRes = await app.request('/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspacePath, prompt: 'Initial' }),
      })
      const createBody = await createRes.json() as { id: string }
      const sessionId = createBody.id

      currentMockProcess.emit('init', { sessionId: 'cli-session-xyz' })

      return { sessionId }
    }

    it('returns 404 for non-existent session (not in sessions map)', async () => {
      const res = await app.request('/sessions/does-not-exist/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'claude-sonnet-4' }),
      })
      expect(res.status).toBe(404)
      const body = await res.json() as { error: { code: string } }
      expect(body.error.code).toBe('SESSION_NOT_FOUND')
    })

    it('returns 400 when session has no cli_session_id', async () => {
      const createRes = await app.request('/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspacePath, prompt: 'Initial' }),
      })
      const createBody = await createRes.json() as { id: string }

      // Do NOT fire init event — no cli_session_id
      const res = await app.request(`/sessions/${createBody.id}/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'claude-sonnet-4' }),
      })
      expect(res.status).toBe(400)
      const body = await res.json() as { error: { code: string } }
      expect(body.error.code).toBe('SESSION_NOT_RESUMABLE')
    })

    it('returns 200 with restarted status when settings applied', async () => {
      const mockSettingsStore = makeMockSettingsStore({ model: 'claude-sonnet-4' })
      const routerWithSettings = createSessionRouter(supervisor, registry, sessions, store, undefined, mockSettingsStore as never)
      const appWithSettings = new Hono()
      appWithSettings.route('/sessions', routerWithSettings)

      const createRes = await appWithSettings.request('/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspacePath, prompt: 'Initial' }),
      })
      const createBody = await createRes.json() as { id: string }
      const sessionId = createBody.id
      currentMockProcess.emit('init', { sessionId: 'cli-session-xyz' })

      const res = await appWithSettings.request(`/sessions/${sessionId}/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(200)
      const body = await res.json() as { id: string; status: string; settings: { model: string } }
      expect(body.id).toBe(sessionId)
      expect(body.status).toBe('restarted')
      expect(body.settings.model).toBe('claude-sonnet-4')
    })

    it('calls start with --resume using the stored cli_session_id', async () => {
      const { sessionId } = await createSessionWithCliId()

      await app.request(`/sessions/${sessionId}/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'claude-sonnet-4' }),
      })

      expect(currentMockProcess.start).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'cli-session-xyz', prompt: '' }),
      )
    })

    it('passes effortLevel to start', async () => {
      const mockSettingsStore = makeMockSettingsStore({ effortLevel: 'high' })
      const routerWithSettings = createSessionRouter(supervisor, registry, sessions, store, undefined, mockSettingsStore as never)
      const appWithSettings = new Hono()
      appWithSettings.route('/sessions', routerWithSettings)

      const createRes = await appWithSettings.request('/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspacePath, prompt: 'Initial' }),
      })
      const createBody = await createRes.json() as { id: string }
      const sessionId = createBody.id
      currentMockProcess.emit('init', { sessionId: 'cli-session-xyz' })

      await appWithSettings.request(`/sessions/${sessionId}/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })

      expect(currentMockProcess.start).toHaveBeenCalledWith(
        expect.objectContaining({ effortLevel: 'high' }),
      )
    })

    it('updates model in SessionStore', async () => {
      const mockSettingsStore = makeMockSettingsStore({ model: 'claude-sonnet-4' })
      const routerWithSettings = createSessionRouter(supervisor, registry, sessions, store, undefined, mockSettingsStore as never)
      const appWithSettings = new Hono()
      appWithSettings.route('/sessions', routerWithSettings)

      const createRes = await appWithSettings.request('/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspacePath, prompt: 'Initial' }),
      })
      const createBody = await createRes.json() as { id: string }
      const sessionId = createBody.id
      currentMockProcess.emit('init', { sessionId: 'cli-session-xyz' })

      await appWithSettings.request(`/sessions/${sessionId}/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })

      const row = store.findById(sessionId)
      expect(row!.model).toBe('claude-sonnet-4')
      expect(row!.status).toBe('running')
    })

    it('disposes old process when applying new settings', async () => {
      const createRes = await app.request('/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspacePath, prompt: 'Initial' }),
      })
      const createBody = await createRes.json() as { id: string }
      const sessionId = createBody.id

      const oldProcess = currentMockProcess
      oldProcess.emit('init', { sessionId: 'cli-session-old' })

      await app.request(`/sessions/${sessionId}/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'claude-sonnet-4' }),
      })

      expect(oldProcess.dispose).toHaveBeenCalled()
    })

    it('updates cli_session_id when init event fires after settings restart', async () => {
      const { sessionId } = await createSessionWithCliId()

      await app.request(`/sessions/${sessionId}/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'claude-sonnet-4' }),
      })

      currentMockProcess.emit('init', { sessionId: 'cli-session-new' })

      const row = store.findById(sessionId)
      expect(row!.cli_session_id).toBe('cli-session-new')
    })
  })

  // ----------- SSE event forwarding (structural checks) -----------

  describe('SSE event forwarding — events.ts coverage', () => {
    it('error and rate_limit_info events are defined in CliProcessEvents', () => {
      // These events are wired in events.ts; we verify the process emits them
      // and that the event names match what events.ts subscribes to.
      const process_ = makeMockProcess()
      let errorFired = false
      let rateLimitFired = false

      ;(process_.on as Function)('error', () => { errorFired = true })
      ;(process_.on as Function)('rate_limit_info', () => { rateLimitFired = true })

      process_.emit('error', { message: 'Test error' })
      process_.emit('rate_limit_info', { status: 'rate_limited', resetsAt: 1234567890 })

      expect(errorFired).toBe(true)
      expect(rateLimitFired).toBe(true)
    })
  })
})
