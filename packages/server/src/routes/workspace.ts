import { Hono } from 'hono'
import { randomUUID } from 'node:crypto'
import { CreateWorkspaceRequestSchema } from '@nexus/shared'
import { validateBody } from '../middleware/validation.js'
import type { WorkspaceRegistry } from '../domain/workspace/workspace-registry.js'

type Env = { Variables: { validatedBody: unknown } }

export function createWorkspaceRouter(registry: WorkspaceRegistry) {
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

  router.post('/', validateBody(CreateWorkspaceRequestSchema), (c) => {
    const body = c.get('validatedBody') as { path: string; name?: string }
    const result = registry.add({
      id: randomUUID(),
      path: body.path,
      name: body.name,
    })
    if (!result.ok) {
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
    return c.json({ success: true })
  })

  return router
}
