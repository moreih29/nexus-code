import { Hono } from 'hono'
import { randomUUID } from 'node:crypto'
import { StartSessionRequestSchema } from '@nexus/shared'
import { validateBody } from '../middleware/validation.js'
import type { ProcessSupervisor } from '../adapters/cli/process-supervisor.js'
import type { WorkspaceRegistry } from '../domain/workspace/workspace-registry.js'
import type { CliProcess } from '../adapters/cli/cli-process.js'

type Env = { Variables: { validatedBody: unknown } }

export interface SessionRecord {
  id: string
  workspacePath: string
  agentId: string
  process: CliProcess
  createdAt: Date
}

export function createSessionRouter(
  supervisor: ProcessSupervisor,
  registry: WorkspaceRegistry,
  sessions: Map<string, SessionRecord>,
) {
  const router = new Hono<Env>()

  router.post('/', validateBody(StartSessionRequestSchema), async (c) => {
    const body = c.get('validatedBody') as {
      workspacePath: string
      prompt: string
      permissionMode?: 'auto' | 'manual'
      model?: string
    }

    const wsResult = registry.get(body.workspacePath)
    if (!wsResult.ok) {
      return c.json(
        { error: { code: wsResult.error.code, message: wsResult.error.message } },
        404,
      )
    }

    let group = supervisor.getGroup(body.workspacePath)
    if (!group) {
      const groupResult = supervisor.createGroup(body.workspacePath)
      if (!groupResult.ok) {
        return c.json(
          { error: { code: groupResult.error.code, message: groupResult.error.message } },
          500,
        )
      }
      group = groupResult.value
    }

    const agentId = randomUUID()
    const processResult = group.createProcess(agentId)
    if (!processResult.ok) {
      return c.json(
        { error: { code: processResult.error.code, message: processResult.error.message } },
        500,
      )
    }

    const cliProcess = processResult.value

    const permissionMode =
      body.permissionMode === 'auto' ? 'auto' : undefined

    const startResult = await cliProcess.start({
      prompt: body.prompt,
      cwd: body.workspacePath,
      permissionMode: permissionMode,
      model: body.model,
    })

    if (!startResult.ok) {
      group.removeProcess(agentId)
      return c.json(
        { error: { code: startResult.error.code, message: startResult.error.message } },
        500,
      )
    }

    const sessionId = randomUUID()
    const record: SessionRecord = {
      id: sessionId,
      workspacePath: body.workspacePath,
      agentId,
      process: cliProcess,
      createdAt: new Date(),
    }
    sessions.set(sessionId, record)

    return c.json(
      {
        id: sessionId,
        workspacePath: body.workspacePath,
        status: cliProcess.getStatus(),
        createdAt: record.createdAt.toISOString(),
      },
      201,
    )
  })

  router.post('/:id/prompt', async (c) => {
    const id = c.req.param('id')
    const record = sessions.get(id)
    if (!record) {
      return c.json({ error: { code: 'SESSION_NOT_FOUND', message: `Session '${id}' not found` } }, 404)
    }

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: { code: 'INVALID_JSON', message: 'Request body must be valid JSON' } }, 400)
    }

    if (
      typeof body !== 'object' ||
      body === null ||
      typeof (body as Record<string, unknown>)['prompt'] !== 'string'
    ) {
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: 'Field "prompt" is required and must be a string' } },
        400,
      )
    }

    const prompt = (body as Record<string, unknown>)['prompt'] as string
    const result = record.process.sendPrompt(prompt)
    if (!result.ok) {
      return c.json({ error: { code: result.error.code, message: result.error.message } }, 400)
    }

    return c.json({ success: true })
  })

  router.post('/:id/cancel', async (c) => {
    const id = c.req.param('id')
    const record = sessions.get(id)
    if (!record) {
      return c.json({ error: { code: 'SESSION_NOT_FOUND', message: `Session '${id}' not found` } }, 404)
    }

    await record.process.cancel()
    return c.json({ success: true })
  })

  router.get('/:id/status', (c) => {
    const id = c.req.param('id')
    const record = sessions.get(id)
    if (!record) {
      return c.json({ error: { code: 'SESSION_NOT_FOUND', message: `Session '${id}' not found` } }, 404)
    }

    return c.json({
      id: record.id,
      workspacePath: record.workspacePath,
      status: record.process.getStatus(),
      createdAt: record.createdAt.toISOString(),
    })
  })

  return router
}
