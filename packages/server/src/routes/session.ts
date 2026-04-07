import { Hono } from 'hono'
import { randomUUID } from 'node:crypto'
import { StartSessionRequestSchema } from '@nexus/shared'
import { validateBody } from '../middleware/validation.js'
import type { ProcessSupervisor } from '../adapters/cli/process-supervisor.js'
import type { WorkspaceRegistry } from '../domain/workspace/workspace-registry.js'
import type { CliProcess } from '../adapters/cli/cli-process.js'
import type { SessionStore } from '../adapters/db/session-store.js'
import type { HookManager } from '../adapters/hooks/hook-manager.js'

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
  store: SessionStore,
  hookManager?: HookManager,
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

    if (hookManager) {
      await hookManager.injectHooks(body.workspacePath)
    }

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
    cliProcess.meta['sessionId'] = sessionId
    cliProcess.meta['agentId'] = agentId

    const dbRow = store.create({
      id: sessionId,
      workspacePath: body.workspacePath,
      agentId,
      status: 'running',
      model: body.model,
      permissionMode: body.permissionMode,
      prompt: body.prompt,
    })

    cliProcess.on('init', (data) => {
      store.updateCliSessionId(sessionId, data.sessionId)
    })

    cliProcess.on('status_change', ({ status }) => {
      if (status === 'stopped' || status === 'error') {
        store.markEnded(sessionId, status === 'stopped' ? 0 : 1, status === 'error' ? 'Process exited with error' : null)
      } else {
        store.updateStatus(sessionId, status)
      }
    })

    const record: SessionRecord = {
      id: sessionId,
      workspacePath: body.workspacePath,
      agentId,
      process: cliProcess,
      createdAt: new Date(dbRow.created_at),
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

  router.get('/', (c) => {
    const workspacePath = c.req.query('workspacePath')
    if (!workspacePath) {
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: 'Query parameter "workspacePath" is required' } },
        400,
      )
    }

    const rows = store.listByWorkspace(workspacePath)
    return c.json(rows)
  })

  router.post('/:id/resume', async (c) => {
    const id = c.req.param('id')
    const dbRow = store.findById(id)
    if (!dbRow) {
      return c.json(
        { error: { code: 'SESSION_NOT_FOUND', message: `Session '${id}' not found` } },
        404,
      )
    }

    if (!dbRow.cli_session_id) {
      return c.json(
        { error: { code: 'SESSION_NOT_RESUMABLE', message: `Session '${id}' has no CLI session id to resume` } },
        400,
      )
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

    const wsResult = registry.get(dbRow.workspace_path)
    if (!wsResult.ok) {
      return c.json(
        { error: { code: wsResult.error.code, message: wsResult.error.message } },
        404,
      )
    }

    let group = supervisor.getGroup(dbRow.workspace_path)
    if (!group) {
      const groupResult = supervisor.createGroup(dbRow.workspace_path)
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
    const startResult = await cliProcess.start({
      prompt,
      cwd: dbRow.workspace_path,
      sessionId: dbRow.cli_session_id,
      model: dbRow.model ?? undefined,
    })

    if (!startResult.ok) {
      group.removeProcess(agentId)
      return c.json(
        { error: { code: startResult.error.code, message: startResult.error.message } },
        500,
      )
    }

    const newSessionId = randomUUID()
    cliProcess.meta['sessionId'] = newSessionId
    cliProcess.meta['agentId'] = agentId

    const newRow = store.create({
      id: newSessionId,
      workspacePath: dbRow.workspace_path,
      agentId,
      status: 'running',
      model: dbRow.model ?? undefined,
      permissionMode: dbRow.permission_mode ?? undefined,
      prompt,
    })

    cliProcess.on('init', (data) => {
      store.updateCliSessionId(newSessionId, data.sessionId)
    })

    cliProcess.on('status_change', ({ status }) => {
      if (status === 'stopped' || status === 'error') {
        store.markEnded(newSessionId, status === 'stopped' ? 0 : 1, status === 'error' ? 'Process exited with error' : null)
      } else {
        store.updateStatus(newSessionId, status)
      }
    })

    const record: SessionRecord = {
      id: newSessionId,
      workspacePath: dbRow.workspace_path,
      agentId,
      process: cliProcess,
      createdAt: new Date(newRow.created_at),
    }
    sessions.set(newSessionId, record)

    return c.json(
      {
        id: newSessionId,
        workspacePath: dbRow.workspace_path,
        status: cliProcess.getStatus(),
        createdAt: record.createdAt.toISOString(),
        resumedFromSessionId: id,
      },
      201,
    )
  })

  router.post('/:id/restart', async (c) => {
    const id = c.req.param('id')
    const dbRow = store.findById(id)
    if (!dbRow) {
      return c.json(
        { error: { code: 'SESSION_NOT_FOUND', message: `Session '${id}' not found` } },
        404,
      )
    }

    if (!dbRow.cli_session_id) {
      return c.json(
        { error: { code: 'SESSION_NOT_RESUMABLE', message: `Session '${id}' has no CLI session id to restart from` } },
        400,
      )
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

    // Dispose existing process if still tracked
    const existingRecord = sessions.get(id)
    if (existingRecord) {
      const existingGroup = supervisor.getGroup(existingRecord.workspacePath)
      if (existingGroup) {
        existingGroup.removeProcess(existingRecord.agentId)
      }
      sessions.delete(id)
    }

    const wsResult = registry.get(dbRow.workspace_path)
    if (!wsResult.ok) {
      return c.json(
        { error: { code: wsResult.error.code, message: wsResult.error.message } },
        404,
      )
    }

    let group = supervisor.getGroup(dbRow.workspace_path)
    if (!group) {
      const groupResult = supervisor.createGroup(dbRow.workspace_path)
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
    const startResult = await cliProcess.start({
      prompt,
      cwd: dbRow.workspace_path,
      sessionId: dbRow.cli_session_id,
      model: dbRow.model ?? undefined,
    })

    if (!startResult.ok) {
      group.removeProcess(agentId)
      return c.json(
        { error: { code: startResult.error.code, message: startResult.error.message } },
        500,
      )
    }

    cliProcess.meta['sessionId'] = id
    cliProcess.meta['agentId'] = agentId

    store.updateStatus(id, 'running')

    cliProcess.on('init', (data) => {
      store.updateCliSessionId(id, data.sessionId)
    })

    cliProcess.on('status_change', ({ status }) => {
      if (status === 'stopped' || status === 'error') {
        store.markEnded(id, status === 'stopped' ? 0 : 1, status === 'error' ? 'Process exited with error' : null)
      } else {
        store.updateStatus(id, status)
      }
    })

    const record: SessionRecord = {
      id,
      workspacePath: dbRow.workspace_path,
      agentId,
      process: cliProcess,
      createdAt: new Date(dbRow.created_at),
    }
    sessions.set(id, record)

    return c.json(
      {
        id,
        workspacePath: dbRow.workspace_path,
        status: cliProcess.getStatus(),
        createdAt: record.createdAt.toISOString(),
        restartedFromCliSessionId: dbRow.cli_session_id,
      },
      200,
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
