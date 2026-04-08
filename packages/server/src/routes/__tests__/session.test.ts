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

// ----------- Mock helpers (same pattern as session-lifecycle.test.ts) -----------

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

function makeMockSettingsStore(settings: Record<string, unknown> = {}) {
  return {
    getEffectiveSettings: vi.fn().mockReturnValue(settings),
  }
}

// ----------- Test setup -----------

describe('session routes — supplemental tests', () => {
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

  // Helper: create a session and emit init to assign cli_session_id
  async function createSessionWithCliId(cliSessionId = 'cli-session-abc'): Promise<{ sessionId: string }> {
    const res = await app.request('/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspacePath, prompt: 'Initial prompt' }),
    })
    const body = await res.json() as { id: string }
    currentMockProcess.emit('init', { sessionId: cliSessionId })
    return { sessionId: body.id }
  }

  // ----------- POST /sessions/:id/prompt — auto-restart on settings change -----------

  describe('POST /sessions/:id/prompt — auto-restart', () => {
    it('auto-restarts and returns { success: true, restarted: true } when settings changed', async () => {
      // Settings at session creation time
      const initialSettings = { model: 'sonnet' }
      const changedSettings = { model: 'opus' }

      const settingsStore = makeMockSettingsStore(initialSettings)
      const router = createSessionRouter(supervisor, registry, sessions, store, undefined, settingsStore as never)
      const testApp = new Hono()
      testApp.route('/sessions', router)

      // Create session with initial settings
      const createRes = await testApp.request('/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspacePath, prompt: 'First prompt' }),
      })
      const createBody = await createRes.json() as { id: string }
      const sessionId = createBody.id
      currentMockProcess.emit('init', { sessionId: 'cli-session-initial' })

      // Update settings store to return changed settings
      settingsStore.getEffectiveSettings.mockReturnValue(changedSettings)

      // Send next prompt — should trigger auto-restart
      const res = await testApp.request(`/sessions/${sessionId}/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'Second prompt after settings change' }),
      })

      expect(res.status).toBe(200)
      const body = await res.json() as { success: boolean; restarted: boolean }
      expect(body.success).toBe(true)
      expect(body.restarted).toBe(true)
    })

    it('falls back to existing process when auto-restart fails', async () => {
      const initialSettings = { model: 'sonnet' }
      const changedSettings = { model: 'opus' }

      // Use a call-count-aware factory: first process starts fine, second fails
      let callCount = 0
      const processes: MockProcess[] = []
      const failingFactory: CliProcessFactory = () => {
        const p = makeMockProcess()
        callCount++
        if (callCount > 1) {
          // Second process creation: start returns failure
          p.start.mockResolvedValue({ ok: false, error: { code: 'START_FAILED', message: 'Process failed to start' } })
        }
        processes.push(p)
        currentMockProcess = p
        return p as unknown as CliProcess
      }

      const failingSupervisor = new ProcessSupervisor(30, 10, failingFactory)
      const eventPort2 = new EventEmitterAdapter()
      const registry2 = new WorkspaceRegistry(eventPort2)
      registry2.add({ id: randomUUID(), path: workspacePath })
      const sessions2 = new Map<string, SessionRecord>()

      const settingsStore = makeMockSettingsStore(initialSettings)
      const router = createSessionRouter(failingSupervisor, registry2, sessions2, store, undefined, settingsStore as never)
      const testApp = new Hono()
      testApp.route('/sessions', router)

      const createRes = await testApp.request('/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspacePath, prompt: 'First prompt' }),
      })
      const createBody = await createRes.json() as { id: string }
      const sessionId = createBody.id

      // Record the first (original) process before it gets replaced
      const firstProcess = processes[0]!
      firstProcess.emit('init', { sessionId: 'cli-session-initial' })

      // Settings changed — will trigger auto-restart attempt
      settingsStore.getEffectiveSettings.mockReturnValue(changedSettings)

      const res = await testApp.request(`/sessions/${sessionId}/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'Prompt after failed restart' }),
      })

      expect(res.status).toBe(200)
      const body = await res.json() as { success: boolean }
      expect(body.success).toBe(true)
      // restarted flag absent — fell back to sendPrompt on the original process
      expect((body as Record<string, unknown>)['restarted']).toBeUndefined()

      failingSupervisor.dispose()
    })
  })

  // ----------- POST /sessions/:id/resume — new sessionId -----------

  describe('POST /sessions/:id/resume', () => {
    it('creates a new session with a fresh id and returns 201 with resumedFromSessionId', async () => {
      const { sessionId: originalId } = await createSessionWithCliId('cli-session-xyz')

      const res = await app.request(`/sessions/${originalId}/resume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'Resumed prompt' }),
      })

      expect(res.status).toBe(201)
      const body = await res.json() as { id: string; resumedFromSessionId: string }
      // New session id must differ from original
      expect(body.id).not.toBe(originalId)
      expect(body.resumedFromSessionId).toBe(originalId)
    })

    it('passes cli_session_id to start so the CLI resumes the conversation', async () => {
      const { sessionId: originalId } = await createSessionWithCliId('cli-session-xyz')

      await app.request(`/sessions/${originalId}/resume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'Resumed prompt' }),
      })

      expect(currentMockProcess.start).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'cli-session-xyz', prompt: 'Resumed prompt' }),
      )
    })

    it('stores the new session in SessionStore as running', async () => {
      const { sessionId: originalId } = await createSessionWithCliId('cli-session-xyz')

      const res = await app.request(`/sessions/${originalId}/resume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'Resumed prompt' }),
      })

      const body = await res.json() as { id: string }
      const row = store.findById(body.id)
      expect(row).not.toBeNull()
      expect(row!.status).toBe('running')
    })

    it('returns 404 when original session not found', async () => {
      const res = await app.request('/sessions/does-not-exist/resume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'Resumed prompt' }),
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

      const res = await app.request(`/sessions/${createBody.id}/resume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'Resumed prompt' }),
      })
      expect(res.status).toBe(400)
      const body = await res.json() as { error: { code: string } }
      expect(body.error.code).toBe('SESSION_NOT_RESUMABLE')
    })
  })

  // ----------- GET /sessions/:id/history — offset/limit -----------

  describe('GET /sessions/:id/history — offset/limit parameters', () => {
    it('returns 400 for invalid offset (negative)', async () => {
      const { sessionId } = await createSessionWithCliId()

      const res = await app.request(`/sessions/${sessionId}/history?offset=-1`)
      expect(res.status).toBe(400)
      const body = await res.json() as { error: { code: string } }
      expect(body.error.code).toBe('VALIDATION_ERROR')
    })

    it('returns 400 for invalid limit (zero)', async () => {
      const { sessionId } = await createSessionWithCliId()

      const res = await app.request(`/sessions/${sessionId}/history?limit=0`)
      expect(res.status).toBe(400)
      const body = await res.json() as { error: { code: string } }
      expect(body.error.code).toBe('VALIDATION_ERROR')
    })

    it('returns 400 for non-numeric offset', async () => {
      const { sessionId } = await createSessionWithCliId()

      const res = await app.request(`/sessions/${sessionId}/history?offset=abc`)
      expect(res.status).toBe(400)
      const body = await res.json() as { error: { code: string } }
      expect(body.error.code).toBe('VALIDATION_ERROR')
    })

    it('returns 404 when history file does not exist (valid offset/limit defaults)', async () => {
      const { sessionId } = await createSessionWithCliId('nonexistent-cli-session')

      // The history file won't exist — parser returns HISTORY_FILE_NOT_FOUND
      const res = await app.request(`/sessions/${sessionId}/history`)
      expect(res.status).toBe(404)
      const body = await res.json() as { error: { code: string } }
      expect(body.error.code).toBe('HISTORY_FILE_NOT_FOUND')
    })

    it('returns 404 when session not found in store', async () => {
      const res = await app.request('/sessions/does-not-exist/history')
      expect(res.status).toBe(404)
      const body = await res.json() as { error: { code: string } }
      expect(body.error.code).toBe('SESSION_NOT_FOUND')
    })

    it('returns 404 when session has no cli_session_id', async () => {
      const createRes = await app.request('/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspacePath, prompt: 'Initial' }),
      })
      const createBody = await createRes.json() as { id: string }
      // Do NOT fire init event — no cli_session_id

      const res = await app.request(`/sessions/${createBody.id}/history`)
      expect(res.status).toBe(404)
      const body = await res.json() as { error: { code: string } }
      expect(body.error.code).toBe('HISTORY_NOT_AVAILABLE')
    })
  })

  // ----------- POST /sessions/:id/cancel -----------

  describe('POST /sessions/:id/cancel', () => {
    it('returns 200 and calls cancel() on the session process', async () => {
      const createRes = await app.request('/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspacePath, prompt: 'Initial' }),
      })
      const createBody = await createRes.json() as { id: string }
      const sessionId = createBody.id

      const res = await app.request(`/sessions/${sessionId}/cancel`, {
        method: 'POST',
      })

      expect(res.status).toBe(200)
      const body = await res.json() as { success: boolean }
      expect(body.success).toBe(true)
      expect(currentMockProcess.cancel).toHaveBeenCalled()
    })

    it('returns 404 when session not found', async () => {
      const res = await app.request('/sessions/does-not-exist/cancel', {
        method: 'POST',
      })
      expect(res.status).toBe(404)
      const body = await res.json() as { error: { code: string } }
      expect(body.error.code).toBe('SESSION_NOT_FOUND')
    })
  })

  // ----------- GET /sessions — workspacePath required -----------

  describe('GET /sessions — workspacePath query param', () => {
    it('returns 400 when workspacePath is not provided', async () => {
      const res = await app.request('/sessions')
      expect(res.status).toBe(400)
      const body = await res.json() as { error: { code: string } }
      expect(body.error.code).toBe('VALIDATION_ERROR')
    })

    it('returns session list when workspacePath is provided', async () => {
      // Create a session first
      await app.request('/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspacePath, prompt: 'Initial' }),
      })

      const res = await app.request(`/sessions?workspacePath=${encodeURIComponent(workspacePath)}`)
      expect(res.status).toBe(200)
      const rows = await res.json() as unknown[]
      expect(Array.isArray(rows)).toBe(true)
      expect(rows.length).toBeGreaterThan(0)
    })
  })
})
