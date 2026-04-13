import { Hono } from 'hono'
import type { WorkspaceLogger } from '../adapters/logging/workspace-logger.js'
import type { AppVariables } from '../middleware/logging.js'

interface ClientLogEntry {
  workspacePath?: string
  level: 'log' | 'info' | 'warn' | 'error'
  source: string
  message: string
  data?: unknown
  requestId?: string
  ts?: string
}

export function createDevLogRouter(workspaceLogger: WorkspaceLogger) {
  const app = new Hono<{ Variables: AppVariables }>()

  app.post('/client-log', async (c) => {
    const body = await c.req.json<{ entries: ClientLogEntry[] }>().catch(() => null)
    if (!body || !Array.isArray(body.entries)) return c.json({ ok: false }, 400)

    for (const entry of body.entries) {
      const target = entry.workspacePath ?? '_system-web'
      workspaceLogger.log(target, {
        type: 'web_client',
        requestId: entry.requestId ?? c.get('requestId'),
        data: {
          level: entry.level,
          source: entry.source,
          message: entry.message,
          data: entry.data,
          clientTs: entry.ts,
        },
      })
    }

    return c.json({ ok: true, received: body.entries.length })
  })

  return app
}
