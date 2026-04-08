import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import { randomUUID } from 'node:crypto'
import { WorkspaceRegistry } from '../../domain/workspace/workspace-registry.js'
import { EventEmitterAdapter } from '../../adapters/events/event-emitter-adapter.js'
import { createWorkspaceRouter } from '../workspace.js'

// ----------- Mock validate-path so filesystem access isn't needed -----------

vi.mock('../../middleware/validate-path.js', () => ({
  validateWorkspacePath: vi.fn(),
}))

import { validateWorkspacePath } from '../../middleware/validate-path.js'

const mockValidatePath = validateWorkspacePath as ReturnType<typeof vi.fn>

// ----------- Mock WorkspaceStore -----------

function makeMockWorkspaceStore(existing: { id: string; path: string; name: string | null; created_at: string } | null = null) {
  return {
    findByPath: vi.fn().mockReturnValue(existing),
    create: vi.fn((ws: { id: string; path: string; name?: string }) => ({
      id: ws.id,
      path: ws.path,
      name: ws.name ?? null,
      created_at: new Date().toISOString(),
    })),
    remove: vi.fn().mockReturnValue(true),
    list: vi.fn().mockReturnValue([]),
  }
}

// ----------- Test setup -----------

describe('workspace routes', () => {
  let registry: WorkspaceRegistry
  let app: Hono

  const workspacePath = '/tmp/test-workspace'

  beforeEach(() => {
    vi.clearAllMocks()
    // Default: path is valid
    mockValidatePath.mockResolvedValue({ ok: true, value: workspacePath })

    const eventPort = new EventEmitterAdapter()
    registry = new WorkspaceRegistry(eventPort)
  })

  function makeApp(store: ReturnType<typeof makeMockWorkspaceStore>) {
    const router = createWorkspaceRouter(registry, store as never)
    const a = new Hono()
    a.route('/api/workspaces', router)
    return a
  }

  // ----------- GET /api/workspaces — list -----------

  describe('GET /api/workspaces', () => {
    it('returns the full workspace list from registry', async () => {
      const store = makeMockWorkspaceStore()
      // Pre-register a workspace
      registry.add({ id: 'ws-1', path: workspacePath, name: 'My Workspace' })

      app = makeApp(store)
      const res = await app.request('/api/workspaces')

      expect(res.status).toBe(200)
      const body = await res.json() as { workspaces: Array<{ id: string; path: string }> }
      expect(Array.isArray(body.workspaces)).toBe(true)
      expect(body.workspaces.length).toBe(1)
      expect(body.workspaces[0]?.path).toBe(workspacePath)
    })

    it('returns empty list when no workspaces registered', async () => {
      const store = makeMockWorkspaceStore()
      app = makeApp(store)

      const res = await app.request('/api/workspaces')
      expect(res.status).toBe(200)
      const body = await res.json() as { workspaces: unknown[] }
      expect(body.workspaces).toHaveLength(0)
    })
  })

  // ----------- POST /api/workspaces — create -----------

  describe('POST /api/workspaces', () => {
    it('registers a new workspace and returns 201', async () => {
      const store = makeMockWorkspaceStore(null) // no existing
      app = makeApp(store)

      const res = await app.request('/api/workspaces', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: workspacePath }),
      })

      expect(res.status).toBe(201)
      const body = await res.json() as { id: string; path: string }
      expect(body.path).toBe(workspacePath)
      expect(typeof body.id).toBe('string')
    })

    it('returns 409 when workspace path already exists in store', async () => {
      const existing = { id: randomUUID(), path: workspacePath, name: null, created_at: new Date().toISOString() }
      const store = makeMockWorkspaceStore(existing)
      app = makeApp(store)

      const res = await app.request('/api/workspaces', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: workspacePath }),
      })

      expect(res.status).toBe(409)
      const body = await res.json() as { error: { code: string } }
      expect(body.error.code).toBe('WORKSPACE_ALREADY_EXISTS')
    })

    it('returns 400 when path does not exist on filesystem', async () => {
      mockValidatePath.mockResolvedValue({
        ok: false,
        error: { code: 'INVALID_PATH', message: 'Path does not exist' },
      })

      const store = makeMockWorkspaceStore(null)
      app = makeApp(store)

      const res = await app.request('/api/workspaces', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: '/nonexistent/path' }),
      })

      expect(res.status).toBe(400)
      const body = await res.json() as { error: { code: string } }
      expect(body.error.code).toBe('INVALID_PATH')
    })

    it('returns 409 when registry already contains the same path', async () => {
      // Pre-register in registry
      registry.add({ id: 'ws-existing', path: workspacePath })

      const store = makeMockWorkspaceStore(null) // store says not found
      app = makeApp(store)

      const res = await app.request('/api/workspaces', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: workspacePath }),
      })

      // store.findByPath returns null but registry.add returns WORKSPACE_ALREADY_EXISTS
      expect(res.status).toBe(409)
      const body = await res.json() as { error: { code: string } }
      expect(body.error.code).toBe('WORKSPACE_ALREADY_EXISTS')
    })
  })

  // ----------- DELETE /api/workspaces/:path — delete -----------

  describe('DELETE /api/workspaces/:path', () => {
    it('removes the workspace and returns success', async () => {
      registry.add({ id: 'ws-1', path: workspacePath })

      const store = makeMockWorkspaceStore()
      app = makeApp(store)

      // Path is encoded without leading slash in the route param (route prepends '/')
      const encodedPath = encodeURIComponent(workspacePath.slice(1))
      const res = await app.request(`/api/workspaces/${encodedPath}`, {
        method: 'DELETE',
      })

      expect(res.status).toBe(200)
      const body = await res.json() as { success: boolean }
      expect(body.success).toBe(true)
    })

    it('returns 404 when workspace is not in registry', async () => {
      const store = makeMockWorkspaceStore()
      app = makeApp(store)

      const encodedPath = encodeURIComponent(workspacePath.slice(1))
      const res = await app.request(`/api/workspaces/${encodedPath}`, {
        method: 'DELETE',
      })

      expect(res.status).toBe(404)
      const body = await res.json() as { error: { code: string } }
      expect(body.error.code).toBe('WORKSPACE_NOT_FOUND')
    })

    it('handles nested multi-segment paths correctly via :path{.+}', async () => {
      const nestedPath = '/Users/kih/projects/my-app'
      registry.add({ id: 'ws-nested', path: nestedPath })

      const store = makeMockWorkspaceStore()
      app = makeApp(store)

      // The route strips the leading slash by doing '/' + param
      // So the param should be everything after the leading slash
      const paramPath = nestedPath.slice(1) // 'Users/kih/projects/my-app'
      const res = await app.request(`/api/workspaces/${paramPath}`, {
        method: 'DELETE',
      })

      expect(res.status).toBe(200)
      const body = await res.json() as { success: boolean }
      expect(body.success).toBe(true)
    })
  })
})
