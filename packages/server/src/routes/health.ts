import { Hono } from 'hono'
import type { HookManager } from '../adapters/hooks/hook-manager.js'

export function createHealthRouter(hookManager: HookManager) {
  const router = new Hono()

  router.get('/', (c) => {
    return c.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      hooks: {
        active: hookManager.getActiveWorkspaceCount(),
      },
    })
  })

  return router
}

// Backwards-compatible default export without hook info
const health = new Hono()
health.get('/', (c) => {
  return c.json({ status: 'ok', timestamp: new Date().toISOString() })
})
export default health
