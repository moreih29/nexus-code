import { Hono } from 'hono'
import { ApprovalResponseSchema } from '@nexus/shared'
import type { ApprovalRequest } from '@nexus/shared'
import { validateBody } from '../middleware/validation.js'

export interface PendingApproval extends ApprovalRequest {
  sessionId: string
}

type Env = { Variables: { validatedBody: unknown } }

export function createApprovalRouter(approvals: Map<string, PendingApproval>) {
  const router = new Hono<Env>()

  router.get('/', (c) => {
    const list = Array.from(approvals.values())
    return c.json({ approvals: list })
  })

  router.post('/:id/respond', validateBody(ApprovalResponseSchema), (c) => {
    const id = c.req.param('id')
    const approval = approvals.get(id)
    if (!approval) {
      return c.json(
        { error: { code: 'APPROVAL_NOT_FOUND', message: `Approval '${id}' not found` } },
        404,
      )
    }

    const body = c.get('validatedBody') as {
      permissionId: string
      approved: boolean
      scope?: 'session' | 'permanent'
    }

    approvals.delete(id)
    return c.json({ permissionId: body.permissionId, approved: body.approved, scope: body.scope })
  })

  return router
}
