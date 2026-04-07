import { Hono } from 'hono'
import { randomUUID } from 'node:crypto'
import { CreateWorkspaceRequestSchema } from '@nexus/shared'
import { validateBody } from '../middleware/validation.js'
import { validateWorkspacePath } from '../middleware/validate-path.js'
import type { WorkspaceRegistry } from '../domain/workspace/workspace-registry.js'
import type { WorkspaceStore } from '../adapters/db/workspace-store.js'

type Env = { Variables: { validatedBody: unknown } }

export function createWorkspaceRouter(registry: WorkspaceRegistry, store: WorkspaceStore) {
  const router = new Hono<Env>()

  router.get('/', (c) => {
    const result = registry.list()
    if (!result.ok) {
      return c.json({ error: { code: result.error.code, message: result.error.message } }, 500)
    }
    const workspaces = result.value.map((ws) => ({
      id: ws.id,
      path: ws.path,
      name: ws.name,
    }))
    return c.json({ workspaces })
  })

  router.post('/', validateBody(CreateWorkspaceRequestSchema), async (c) => {
    const body = c.get('validatedBody') as { path: string; name?: string }

    const pathResult = await validateWorkspacePath(body.path)
    if (!pathResult.ok) {
      return c.json(
        { error: { code: pathResult.error.code, message: pathResult.error.message } },
        400,
      )
    }
    const resolvedPath = pathResult.value

    const existing = store.findByPath(resolvedPath)
    if (existing) {
      return c.json(
        { error: { code: 'WORKSPACE_ALREADY_EXISTS', message: `Workspace at path '${resolvedPath}' already exists` } },
        409,
      )
    }

    const id = randomUUID()
    const row = store.create({ id, path: resolvedPath, name: body.name })

    const result = registry.add({ id: row.id, path: row.path, name: row.name ?? undefined })
    if (!result.ok) {
      store.remove(row.path)
      const status = result.error.code === 'WORKSPACE_ALREADY_EXISTS' ? 409 : 500
      return c.json({ error: { code: result.error.code, message: result.error.message } }, status)
    }

    const ws = result.value
    return c.json({ id: ws.id, path: ws.path, name: ws.name }, 201)
  })

  router.delete('/:path{.+}', (c) => {
    const path = '/' + c.req.param('path')

    const result = registry.remove(path)
    if (!result.ok) {
      const status = result.error.code === 'WORKSPACE_NOT_FOUND' ? 404 : 500
      return c.json({ error: { code: result.error.code, message: result.error.message } }, status)
    }

    store.remove(path)
    return c.json({ success: true })
  })

  return router
}
