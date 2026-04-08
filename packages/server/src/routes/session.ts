import { Hono } from 'hono'
import { randomUUID } from 'node:crypto'
import { StartSessionRequestSchema } from '@nexus/shared'
import { validateBody } from '../middleware/validation.js'
import type { ProcessSupervisor } from '../adapters/cli/process-supervisor.js'
import type { WorkspaceRegistry } from '../domain/workspace/workspace-registry.js'
import type { CliProcess } from '../adapters/cli/cli-process.js'
import type { SessionStore } from '../adapters/db/session-store.js'
import type { HookManager } from '../adapters/hooks/hook-manager.js'
import type { SettingsStore } from '../adapters/db/settings-store.js'
import { getSessionFilePath, parseSessionHistory } from '../adapters/cli/history-parser.js'

const LEGACY_MODEL_MAP: Record<string, string> = {
  'claude-opus-4-5': 'opus',
  'claude-sonnet-4-5': 'sonnet',
  'claude-haiku-4-5': 'haiku',
  'claude-opus-4-6': 'opus',
  'claude-sonnet-4-6': 'sonnet',
  'claude-haiku-4-6': 'haiku',
}

function normalizeModel(model: string | null | undefined): string | undefined {
  if (!model) return undefined
  return LEGACY_MODEL_MAP[model] ?? model
}

type Env = { Variables: { validatedBody: unknown } }

/** CLI-relevant settings keys for comparison (excludes theme which is UI-only) */
const CLI_SETTINGS_KEYS = ['model', 'effortLevel', 'permissionMode', 'maxTurns', 'maxBudgetUsd', 'appendSystemPrompt', 'addDirs', 'disallowedTools', 'chromeEnabled'] as const

function pickCliSettings(s: Record<string, unknown>): Record<string, unknown> {
  const picked: Record<string, unknown> = {}
  for (const k of CLI_SETTINGS_KEYS) {
    if (s[k] !== undefined) picked[k] = s[k]
  }
  return picked
}

function settingsChanged(a: object, b: object): boolean {
  return JSON.stringify(pickCliSettings(a as Record<string, unknown>)) !== JSON.stringify(pickCliSettings(b as Record<string, unknown>))
}

export interface SessionRecord {
  id: string
  workspacePath: string
  agentId: string
  process: CliProcess
  createdAt: Date
  /** Settings the CLI process was started with */
  startedWithSettings?: object
}

/** Wire a CLI process to session infrastructure: set meta, register event handlers, create record */
function wireSessionProcess(opts: {
  sessionId: string
  agentId: string
  workspacePath: string
  cliProcess: CliProcess
  store: SessionStore
  sessions: Map<string, SessionRecord>
  createdAt: Date
  settings?: object
}): SessionRecord {
  const { sessionId, agentId, workspacePath, cliProcess, store, sessions, createdAt, settings } = opts

  // Set meta BEFORE start() to avoid race condition with SSE events
  cliProcess.nexusSessionId = sessionId
  cliProcess.nexusAgentId = agentId

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
    workspacePath,
    agentId,
    process: cliProcess,
    createdAt,
    startedWithSettings: settings ? { ...settings } : undefined,
  }
  sessions.set(sessionId, record)
  return record
}

export function createSessionRouter(
  supervisor: ProcessSupervisor,
  registry: WorkspaceRegistry,
  sessions: Map<string, SessionRecord>,
  store: SessionStore,
  hookManager?: HookManager,
  settingsStore?: SettingsStore,
) {
  const router = new Hono<Env>()

  router.post('/', validateBody(StartSessionRequestSchema), async (c) => {
    const body = c.get('validatedBody') as {
      workspacePath: string
      prompt: string
      permissionMode?: 'default' | 'auto' | 'plan' | 'bypassPermissions'
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

    const effectiveSettings = settingsStore?.getEffectiveSettings(body.workspacePath) ?? {}

    const permissionMode =
      body.permissionMode === 'auto' ? 'auto' :
      body.permissionMode === 'bypassPermissions' ? 'bypassPermissions' :
      undefined

    const sessionId = randomUUID()

    wireSessionProcess({
      sessionId,
      agentId,
      workspacePath: body.workspacePath,
      cliProcess,
      store,
      sessions,
      createdAt: new Date(),
      settings: effectiveSettings,
    })

    const startResult = await cliProcess.start({
      prompt: body.prompt,
      cwd: body.workspacePath,
      permissionMode: permissionMode,
      model: normalizeModel(effectiveSettings.model ?? body.model),
      effortLevel: effectiveSettings.effortLevel,
      maxTurns: effectiveSettings.maxTurns,
      maxBudgetUsd: effectiveSettings.maxBudgetUsd,

      appendSystemPrompt: effectiveSettings.appendSystemPrompt,
      addDirs: effectiveSettings.addDirs,
      disallowedTools: effectiveSettings.disallowedTools,
      chromeEnabled: effectiveSettings.chromeEnabled,
    })

    if (!startResult.ok) {
      group.removeProcess(agentId)
      sessions.delete(sessionId)
      return c.json(
        { error: { code: startResult.error.code, message: startResult.error.message } },
        500,
      )
    }

    const dbRow = store.create({
      id: sessionId,
      workspacePath: body.workspacePath,
      agentId,
      status: 'running',
      model: body.model,
      permissionMode: body.permissionMode,
      prompt: body.prompt,
    })

    const record = sessions.get(sessionId)!

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
    const resumeSettings = settingsStore?.getEffectiveSettings(dbRow.workspace_path) ?? {}
    const resolvedModel = normalizeModel(resumeSettings.model ?? dbRow.model)

    if (hookManager) {
      await hookManager.injectHooks(dbRow.workspace_path)
    }

    const newSessionId = randomUUID()

    wireSessionProcess({
      sessionId: newSessionId,
      agentId,
      workspacePath: dbRow.workspace_path,
      cliProcess,
      store,
      sessions,
      createdAt: new Date(),
      settings: resumeSettings,
    })

    const startResult = await cliProcess.start({
      prompt,
      cwd: dbRow.workspace_path,
      sessionId: dbRow.cli_session_id,
      model: resolvedModel,
      effortLevel: resumeSettings.effortLevel,
      maxTurns: resumeSettings.maxTurns,
      maxBudgetUsd: resumeSettings.maxBudgetUsd,

      appendSystemPrompt: resumeSettings.appendSystemPrompt,
      addDirs: resumeSettings.addDirs,
      disallowedTools: resumeSettings.disallowedTools,
      chromeEnabled: resumeSettings.chromeEnabled,
      permissionMode: resumeSettings.permissionMode === 'auto' ? 'auto' : resumeSettings.permissionMode === 'bypassPermissions' ? 'bypassPermissions' : undefined,
    })

    if (!startResult.ok) {
      group.removeProcess(agentId)
      sessions.delete(newSessionId)
      return c.json(
        { error: { code: startResult.error.code, message: startResult.error.message } },
        500,
      )
    }

    store.create({
      id: newSessionId,
      workspacePath: dbRow.workspace_path,
      agentId,
      status: 'running',
      model: resolvedModel,
      permissionMode: dbRow.permission_mode ?? undefined,
      prompt,
    })

    const record = sessions.get(newSessionId)!

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
    const restartSettings = settingsStore?.getEffectiveSettings(dbRow.workspace_path) ?? {}

    if (hookManager) {
      await hookManager.injectHooks(dbRow.workspace_path)
    }

    wireSessionProcess({
      sessionId: id,
      agentId,
      workspacePath: dbRow.workspace_path,
      cliProcess,
      store,
      sessions,
      createdAt: new Date(dbRow.created_at),
      settings: restartSettings,
    })

    const startResult = await cliProcess.start({
      prompt,
      cwd: dbRow.workspace_path,
      sessionId: dbRow.cli_session_id,
      model: normalizeModel(dbRow.model ?? restartSettings.model),
      effortLevel: restartSettings.effortLevel,
      maxTurns: restartSettings.maxTurns,
      maxBudgetUsd: restartSettings.maxBudgetUsd,

      appendSystemPrompt: restartSettings.appendSystemPrompt,
      addDirs: restartSettings.addDirs,
      disallowedTools: restartSettings.disallowedTools,
      chromeEnabled: restartSettings.chromeEnabled,
      permissionMode: restartSettings.permissionMode === 'auto' ? 'auto' : restartSettings.permissionMode === 'bypassPermissions' ? 'bypassPermissions' : undefined,
    })

    if (!startResult.ok) {
      group.removeProcess(agentId)
      sessions.delete(id)
      return c.json(
        { error: { code: startResult.error.code, message: startResult.error.message } },
        500,
      )
    }

    store.updateStatus(id, 'running')

    const record = sessions.get(id)!

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

  router.put('/:id/settings', async (c) => {
    const id = c.req.param('id')
    const record = sessions.get(id)
    if (!record) {
      return c.json({ error: { code: 'SESSION_NOT_FOUND', message: `Session '${id}' not found` } }, 404)
    }

    const dbRow = store.findById(id)
    if (!dbRow?.cli_session_id) {
      return c.json(
        { error: { code: 'SESSION_NOT_RESUMABLE', message: `Session '${id}' has no CLI session id to restart from` } },
        400,
      )
    }

    const effectiveSettings = settingsStore?.getEffectiveSettings(dbRow.workspace_path) ?? {}

    // Dispose existing process
    const existingGroup = supervisor.getGroup(record.workspacePath)
    if (existingGroup) {
      existingGroup.removeProcess(record.agentId)
    }
    sessions.delete(id)

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

    const resolvedModel = normalizeModel(effectiveSettings.model)
    const resolvedPermissionMode =
      dbRow.permission_mode === 'auto' ? 'auto' :
      dbRow.permission_mode === 'bypassPermissions' ? 'bypassPermissions' :
      undefined

    const cliProcess = processResult.value

    if (hookManager) {
      await hookManager.injectHooks(dbRow.workspace_path)
    }

    wireSessionProcess({
      sessionId: id,
      agentId,
      workspacePath: dbRow.workspace_path,
      cliProcess,
      store,
      sessions,
      createdAt: new Date(dbRow.created_at),
      settings: effectiveSettings,
    })

    const startResult = await cliProcess.start({
      prompt: '',
      cwd: dbRow.workspace_path,
      sessionId: dbRow.cli_session_id,
      model: resolvedModel,
      effortLevel: effectiveSettings.effortLevel,
      maxTurns: effectiveSettings.maxTurns,
      maxBudgetUsd: effectiveSettings.maxBudgetUsd,

      appendSystemPrompt: effectiveSettings.appendSystemPrompt,
      addDirs: effectiveSettings.addDirs,
      disallowedTools: effectiveSettings.disallowedTools,
      chromeEnabled: effectiveSettings.chromeEnabled,
      permissionMode: resolvedPermissionMode,
    })

    if (!startResult.ok) {
      group.removeProcess(agentId)
      sessions.delete(id)
      return c.json(
        { error: { code: startResult.error.code, message: startResult.error.message } },
        500,
      )
    }

    store.updateSettings(id, {
      model: resolvedModel,
      permissionMode: dbRow.permission_mode ?? undefined,
    })
    store.updateStatus(id, 'running')

    return c.json({
      id,
      settings: effectiveSettings,
      status: 'restarted',
    })
  })

  router.post('/:id/prompt', async (c) => {
    const id = c.req.param('id')
    let record = sessions.get(id)
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

    // Auto-restart if settings changed since session started
    const dbRow = store.findById(id)
    if (dbRow && settingsStore && record.startedWithSettings) {
      const currentEffective = settingsStore.getEffectiveSettings(record.workspacePath)
      if (settingsChanged(record.startedWithSettings, currentEffective)) {
        try {
          // Create new process BEFORE killing old one
          let group = supervisor.getGroup(record.workspacePath)
          if (!group) {
            const groupResult = supervisor.createGroup(record.workspacePath)
            if (!groupResult.ok) throw new Error(groupResult.error.message)
            group = groupResult.value
          }

          const agentId = randomUUID()
          const processResult = group.createProcess(agentId)
          if (!processResult.ok) throw new Error(processResult.error.message)

          const cliProcess = processResult.value
          const resolvedModel = normalizeModel(currentEffective.model)

          if (hookManager) {
            await hookManager.injectHooks(record.workspacePath)
          }

          wireSessionProcess({
            sessionId: id,
            agentId,
            workspacePath: record.workspacePath,
            cliProcess,
            store,
            sessions,
            createdAt: record.createdAt,
            settings: currentEffective,
          })

          const startResult = await cliProcess.start({
            prompt,
            cwd: record.workspacePath,
            sessionId: dbRow.cli_session_id ?? undefined,
            model: resolvedModel,
            effortLevel: currentEffective.effortLevel,
            maxTurns: currentEffective.maxTurns,
            maxBudgetUsd: currentEffective.maxBudgetUsd,

            appendSystemPrompt: currentEffective.appendSystemPrompt,
            addDirs: currentEffective.addDirs,
            disallowedTools: currentEffective.disallowedTools,
            chromeEnabled: currentEffective.chromeEnabled,
            permissionMode: currentEffective.permissionMode === 'auto' ? 'auto' :
              currentEffective.permissionMode === 'bypassPermissions' ? 'bypassPermissions' : undefined,
          })

          if (!startResult.ok) {
            group.removeProcess(agentId)
            sessions.delete(id)
            throw new Error(startResult.error.message)
          }

          // New process started successfully — now kill old one
          const existingGroup = supervisor.getGroup(record.workspacePath)
          if (existingGroup) {
            existingGroup.removeProcess(record.agentId)
          }

          store.updateSettings(id, {
            model: resolvedModel,
            permissionMode: currentEffective.permissionMode ?? dbRow.permission_mode ?? undefined,
          })

          record = sessions.get(id)!
          // Prompt already included in start() — skip sendPrompt
          return c.json({ success: true, restarted: true })
        } catch (err) {
          // Auto-restart failed — continue with existing process and old settings
          console.error('[session] auto-restart failed, continuing with current process:', err)
        }
      }
    }

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
      isAlive: record.process.isAlive(),
      createdAt: record.createdAt.toISOString(),
    })
  })

  router.get('/:id/history', async (c) => {
    const id = c.req.param('id')
    const dbRow = store.findById(id)
    if (!dbRow) {
      return c.json(
        { error: { code: 'SESSION_NOT_FOUND', message: `Session '${id}' not found` } },
        404,
      )
    }

    if (!dbRow.cli_session_id?.trim()) {
      return c.json(
        { error: { code: 'HISTORY_NOT_AVAILABLE', message: `Session '${id}' has no CLI session id` } },
        404,
      )
    }

    const offsetParam = c.req.query('offset')
    const limitParam = c.req.query('limit')
    const offset = offsetParam !== undefined ? parseInt(offsetParam, 10) : 0
    const limit = limitParam !== undefined ? parseInt(limitParam, 10) : 50

    if (isNaN(offset) || offset < 0) {
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: 'Query parameter "offset" must be a non-negative integer' } },
        400,
      )
    }

    if (isNaN(limit) || limit < 1) {
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: 'Query parameter "limit" must be a positive integer' } },
        400,
      )
    }

    const filePath = getSessionFilePath(dbRow.workspace_path, dbRow.cli_session_id)
    const result = await parseSessionHistory(filePath, { offset, limit })

    if (!result.ok) {
      if (result.error.code === 'HISTORY_FILE_NOT_FOUND') {
        return c.json(
          { error: { code: result.error.code, message: result.error.message } },
          404,
        )
      }
      return c.json(
        { error: { code: result.error.code, message: result.error.message } },
        500,
      )
    }

    return c.json({ messages: result.value, offset, limit })
  })

  return router
}
