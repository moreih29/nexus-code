import { Hono } from 'hono'
import type { ApprovalBridge } from '../adapters/hooks/approval-bridge.js'

export function createApprovalRouter(approvalBridge: ApprovalBridge) {
  const router = new Hono()

  router.get('/', (c) => {
    const list = approvalBridge.listPending()
    return c.json({ approvals: list })
  })

  router.post('/:id/respond', async (c) => {
    const id = c.req.param('id')

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: { code: 'INVALID_JSON', message: 'Request body must be valid JSON' } }, 400)
    }

    if (
      typeof body !== 'object' ||
      body === null ||
      typeof (body as Record<string, unknown>)['decision'] !== 'string'
    ) {
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: 'Field "decision" is required and must be a string' } },
        400,
      )
    }

    const decision = (body as Record<string, unknown>)['decision'] as string
    if (decision !== 'allow' && decision !== 'deny') {
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: 'Field "decision" must be "allow" or "deny"' } },
        400,
      )
    }

    const settled = approvalBridge.respond(id, decision)
    if (!settled) {
      return c.json(
        { error: { code: 'APPROVAL_NOT_FOUND', message: `Approval '${id}' not found` } },
        404,
      )
    }

    return c.json({ id, decision })
  })

  return router
}
