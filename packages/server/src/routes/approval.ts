import { Hono } from 'hono'
import type { ApprovalBridge } from '../adapters/approval/bridge.js'
import type { ApprovalPolicyStore } from '../adapters/db/approval-policy-store.js'
import type { WorkspaceLogger } from '../adapters/logging/workspace-logger.js'
import type { AppVariables } from '../middleware/logging.js'

export function createApprovalRouter(approvalBridge: ApprovalBridge, policyStore?: ApprovalPolicyStore, workspaceLogger?: WorkspaceLogger) {
  const router = new Hono<{ Variables: AppVariables }>()

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

    const scopeRaw = (body as Record<string, unknown>)['scope']
    let scope: 'once' | 'session' | 'permanent' | undefined
    if (scopeRaw !== undefined) {
      if (scopeRaw !== 'once' && scopeRaw !== 'session' && scopeRaw !== 'permanent') {
        return c.json(
          { error: { code: 'VALIDATION_ERROR', message: 'Field "scope" must be "once", "session", or "permanent"' } },
          400,
        )
      }
      scope = scopeRaw
    }

    const pendingEntry = approvalBridge.listPending().find((p) => p.id === id)

    const settled = approvalBridge.respond(id, decision, scope)
    if (!settled) {
      return c.json(
        { error: { code: 'APPROVAL_NOT_FOUND', message: `Approval '${id}' not found` } },
        404,
      )
    }

    if (pendingEntry) {
      workspaceLogger?.log(pendingEntry.workspacePath, { type: 'approval_response', sessionId: pendingEntry.sessionId, requestId: pendingEntry.requestId ?? c.get('requestId'), data: { id, decision, scope: scope ?? 'once' } })
    }

    return c.json({ id, decision, scope: scope ?? 'once' })
  })

  // Rules endpoints (require policyStore)
  router.get('/rules', (c) => {
    if (!policyStore) {
      return c.json({ error: { code: 'NOT_AVAILABLE', message: 'Policy store not configured' } }, 503)
    }
    const workspacePath = c.req.query('workspacePath')
    const rules = policyStore.listPermanentRules(workspacePath)
    return c.json({ rules })
  })

  router.delete('/rules/:id', (c) => {
    if (!policyStore) {
      return c.json({ error: { code: 'NOT_AVAILABLE', message: 'Policy store not configured' } }, 503)
    }
    const id = c.req.param('id')
    policyStore.removePermanentRule(id)
    return c.json({ success: true })
  })

  router.get('/logs', (c) => {
    if (!policyStore) {
      return c.json({ error: { code: 'NOT_AVAILABLE', message: 'Policy store not configured' } }, 503)
    }
    const workspacePath = c.req.query('workspacePath')
    const limitParam = c.req.query('limit')
    const limit = limitParam !== undefined ? parseInt(limitParam, 10) : 100
    const logs = policyStore.getAuditLog(workspacePath, limit)
    return c.json({ logs })
  })

  return router
}
