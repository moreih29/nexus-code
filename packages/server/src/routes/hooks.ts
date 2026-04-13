import { Hono } from 'hono'
import type { HookManager } from '../adapters/hooks/hook-manager.js'
import type { ApprovalBridge } from '../adapters/approval/bridge.js'
import type { WorkspaceLogger } from '../adapters/logging/workspace-logger.js'
import { preflightPaths } from '../adapters/security/path-guard-preflight.js'
import type { AppVariables } from '../middleware/logging.js'

interface HookRequestBody {
  session_id: string
  hook_event_name: string
  tool_name: string
  tool_input: unknown
  tool_use_id: string
  cwd: string
  permission_mode?: string
}

export function createHooksRouter(hookManager: HookManager, approvalBridge: ApprovalBridge, workspaceLogger?: WorkspaceLogger) {
  const router = new Hono<{ Variables: AppVariables }>()

  router.post('/pre-tool-use', async (c) => {
    const token = c.req.query('token')
    if (!token || !hookManager.validateToken(token)) {
      return c.json({ error: { code: 'UNAUTHORIZED', message: 'Invalid or missing token' } }, 401)
    }

    let body: HookRequestBody
    try {
      body = (await c.req.json()) as HookRequestBody
    } catch {
      return c.json({ error: { code: 'INVALID_JSON', message: 'Request body must be valid JSON' } }, 400)
    }

    if (
      typeof body.tool_use_id !== 'string' ||
      typeof body.session_id !== 'string' ||
      typeof body.tool_name !== 'string' ||
      typeof body.cwd !== 'string'
    ) {
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: 'Missing required fields: tool_use_id, session_id, tool_name, cwd' } },
        400,
      )
    }

    const requestId = c.get('requestId') ?? c.req.header('x-request-id') ?? crypto.randomUUID()

    workspaceLogger?.log(body.cwd, { type: 'hook_request', sessionId: body.session_id, requestId, data: { tool_name: body.tool_name, tool_use_id: body.tool_use_id, session_id: body.session_id } })

    const preflight = await preflightPaths(body.tool_name, body.tool_input, body.cwd)

    if (preflight.protectedPaths.length > 0) {
      workspaceLogger?.log(body.cwd, {
        type: 'protected_path_detected',
        sessionId: body.session_id,
        data: { toolName: body.tool_name, paths: preflight.protectedPaths },
      })
    }

    const decision = await approvalBridge.addPending(
      {
        id: body.tool_use_id,
        sessionId: body.session_id,
        toolName: body.tool_name,
        toolInput: body.tool_input,
        workspacePath: body.cwd,
        requestId,
      },
      {
        protectedHint: preflight.protectedPaths,
        parseReason: preflight.parseReason,
        bashFsSubset: preflight.bashFsSubset,
      },
    )

    workspaceLogger?.log(body.cwd, { type: 'hook_response', sessionId: body.session_id, requestId, data: { tool_use_id: body.tool_use_id, decision, reason: decision === 'allow' ? '사용자 승인' : '사용자 거부' } })

    return c.json({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: decision,
        permissionDecisionReason: decision === 'allow' ? '사용자 승인' : '사용자 거부',
      },
    })
  })

  return router
}
