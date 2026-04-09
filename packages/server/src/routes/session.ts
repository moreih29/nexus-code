import { Hono } from 'hono'
import { randomUUID } from 'node:crypto'
import { StartSessionRequestSchema, PromptBodySchema } from '@nexus/shared'
import { validateBody } from '../middleware/validation.js'
import type { ProcessSupervisor } from '../adapters/cli/process-supervisor.js'
import type { WorkspaceRegistry } from '../domain/workspace/workspace-registry.js'
import type { SessionStore } from '../adapters/db/session-store.js'
import type { HookManager } from '../adapters/hooks/hook-manager.js'
import type { SettingsStore } from '../adapters/db/settings-store.js'
import { getSessionFilePath, parseSessionHistory } from '../adapters/cli/history-parser.js'
import { SessionLifecycleService, resolvePermissionMode } from '../services/session-lifecycle-service.js'
export type { SessionRecord } from '../services/session-lifecycle-service.js'
export { wireSessionProcess } from '../services/session-lifecycle-service.js'

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

import type { SessionRecord } from '../services/session-lifecycle-service.js'
import type { WorkspaceLogger } from '../adapters/logging/workspace-logger.js'
// SessionRecord is re-exported above; this local import is for the Map<string, SessionRecord> param type

export function createSessionRouter(
  supervisor: ProcessSupervisor,
  registry: WorkspaceRegistry,
  sessions: Map<string, SessionRecord>,
  store: SessionStore,
  hookManager?: HookManager,
  settingsStore?: SettingsStore,
  workspaceLogger?: WorkspaceLogger,
) {
  const svc = new SessionLifecycleService(supervisor, registry, sessions, store, hookManager, settingsStore)
  const router = new Hono<Env>()

  router.post('/', validateBody(StartSessionRequestSchema), async (c) => {
    const body = c.get('validatedBody') as {
      workspacePath: string
      prompt: string
      permissionMode?: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions'
      model?: string
    }

    const wsCheck = svc.validateWorkspace(body.workspacePath)
    if (!wsCheck.ok) {
      return c.json({ error: { code: wsCheck.error.code, message: wsCheck.error.message } }, 404)
    }

    await svc.injectHooks(body.workspacePath)

    const effectiveSettings = svc.getEffectiveSettings(body.workspacePath)
    const sessionId = randomUUID()

    const result = await svc.wireAndStart({
      sessionId,
      workspacePath: body.workspacePath,
      createdAt: new Date(),
      settings: effectiveSettings,
      startOpts: {
        prompt: body.prompt,
        permissionMode: resolvePermissionMode(body.permissionMode),
        model: normalizeModel(effectiveSettings.model ?? body.model),
        effortLevel: effectiveSettings.effortLevel,
        maxTurns: effectiveSettings.maxTurns,
        maxBudgetUsd: effectiveSettings.maxBudgetUsd,
        appendSystemPrompt: effectiveSettings.appendSystemPrompt,
        addDirs: effectiveSettings.addDirs,
        disallowedTools: effectiveSettings.disallowedTools,
        chromeEnabled: effectiveSettings.chromeEnabled,
      },
    })

    if (!result.ok) {
      return c.json({ error: { code: result.error.code, message: result.error.message } }, 500)
    }

    store.create({
      id: sessionId,
      workspacePath: body.workspacePath,
      agentId: result.value.agentId,
      status: 'running',
      model: body.model,
      permissionMode: body.permissionMode,
      prompt: body.prompt,
    })

    workspaceLogger?.log(body.workspacePath, { type: 'session_start', sessionId, data: { workspacePath: body.workspacePath, prompt: body.prompt, permissionMode: body.permissionMode } })

    const record = sessions.get(sessionId)!

    return c.json(
      {
        id: sessionId,
        workspacePath: body.workspacePath,
        status: result.value.record.process.getStatus(),
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

  router.post('/:id/resume', validateBody(PromptBodySchema), async (c) => {
    const id = c.req.param('id')
    const dbRow = store.findById(id)
    if (!dbRow) {
      return c.json({ error: { code: 'SESSION_NOT_FOUND', message: `Session '${id}' not found` } }, 404)
    }

    if (!dbRow.cli_session_id) {
      return c.json(
        { error: { code: 'SESSION_NOT_RESUMABLE', message: `Session '${id}' has no CLI session id to resume` } },
        400,
      )
    }

    const { prompt } = c.get('validatedBody') as { prompt: string }

    const wsCheck = svc.validateWorkspace(dbRow.workspace_path)
    if (!wsCheck.ok) {
      return c.json({ error: { code: wsCheck.error.code, message: wsCheck.error.message } }, 404)
    }

    await svc.injectHooks(dbRow.workspace_path)

    const resumeSettings = svc.getEffectiveSettings(dbRow.workspace_path)
    const resolvedModel = normalizeModel(resumeSettings.model ?? dbRow.model)
    const newSessionId = randomUUID()

    const result = await svc.wireAndStart({
      sessionId: newSessionId,
      workspacePath: dbRow.workspace_path,
      createdAt: new Date(),
      settings: resumeSettings,
      startOpts: {
        prompt,
        sessionId: dbRow.cli_session_id,
        model: resolvedModel,
        effortLevel: resumeSettings.effortLevel,
        maxTurns: resumeSettings.maxTurns,
        maxBudgetUsd: resumeSettings.maxBudgetUsd,
        appendSystemPrompt: resumeSettings.appendSystemPrompt,
        addDirs: resumeSettings.addDirs,
        disallowedTools: resumeSettings.disallowedTools,
        chromeEnabled: resumeSettings.chromeEnabled,
        permissionMode: resolvePermissionMode(resumeSettings.permissionMode),
      },
    })

    if (!result.ok) {
      return c.json({ error: { code: result.error.code, message: result.error.message } }, 500)
    }

    store.create({
      id: newSessionId,
      workspacePath: dbRow.workspace_path,
      agentId: result.value.agentId,
      status: 'running',
      model: resolvedModel,
      permissionMode: dbRow.permission_mode ?? undefined,
      prompt,
    })

    workspaceLogger?.log(dbRow.workspace_path, { type: 'session_resume', sessionId: newSessionId, data: { sessionId: newSessionId, prompt } })

    const record = sessions.get(newSessionId)!

    return c.json(
      {
        id: newSessionId,
        workspacePath: dbRow.workspace_path,
        status: result.value.record.process.getStatus(),
        createdAt: record.createdAt.toISOString(),
        resumedFromSessionId: id,
      },
      201,
    )
  })

  router.post('/:id/restart', validateBody(PromptBodySchema), async (c) => {
    const id = c.req.param('id')
    const dbRow = store.findById(id)
    if (!dbRow) {
      return c.json({ error: { code: 'SESSION_NOT_FOUND', message: `Session '${id}' not found` } }, 404)
    }

    if (!dbRow.cli_session_id) {
      return c.json(
        { error: { code: 'SESSION_NOT_RESUMABLE', message: `Session '${id}' has no CLI session id to restart from` } },
        400,
      )
    }

    const { prompt } = c.get('validatedBody') as { prompt: string }

    // Dispose existing process if still tracked
    svc.disposeExisting(id)

    const wsCheck = svc.validateWorkspace(dbRow.workspace_path)
    if (!wsCheck.ok) {
      return c.json({ error: { code: wsCheck.error.code, message: wsCheck.error.message } }, 404)
    }

    await svc.injectHooks(dbRow.workspace_path)

    const restartSettings = svc.getEffectiveSettings(dbRow.workspace_path)

    const result = await svc.wireAndStart({
      sessionId: id,
      workspacePath: dbRow.workspace_path,
      createdAt: new Date(dbRow.created_at),
      settings: restartSettings,
      startOpts: {
        prompt,
        sessionId: dbRow.cli_session_id,
        model: normalizeModel(dbRow.model ?? restartSettings.model),
        effortLevel: restartSettings.effortLevel,
        maxTurns: restartSettings.maxTurns,
        maxBudgetUsd: restartSettings.maxBudgetUsd,
        appendSystemPrompt: restartSettings.appendSystemPrompt,
        addDirs: restartSettings.addDirs,
        disallowedTools: restartSettings.disallowedTools,
        chromeEnabled: restartSettings.chromeEnabled,
        permissionMode: resolvePermissionMode(restartSettings.permissionMode),
      },
    })

    if (!result.ok) {
      return c.json({ error: { code: result.error.code, message: result.error.message } }, 500)
    }

    store.updateStatus(id, 'running')

    const record = sessions.get(id)!

    return c.json(
      {
        id,
        workspacePath: dbRow.workspace_path,
        status: result.value.record.process.getStatus(),
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

    const effectiveSettings = svc.getEffectiveSettings(dbRow.workspace_path)

    // Dispose existing process
    svc.disposeExisting(id)

    const wsCheck = svc.validateWorkspace(dbRow.workspace_path)
    if (!wsCheck.ok) {
      return c.json({ error: { code: wsCheck.error.code, message: wsCheck.error.message } }, 404)
    }

    await svc.injectHooks(dbRow.workspace_path)

    const resolvedModel = normalizeModel(effectiveSettings.model)
    const resolvedPermissionMode = resolvePermissionMode(dbRow.permission_mode)

    const result = await svc.wireAndStart({
      sessionId: id,
      workspacePath: dbRow.workspace_path,
      createdAt: new Date(dbRow.created_at),
      settings: effectiveSettings,
      startOpts: {
        prompt: '',
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
      },
    })

    if (!result.ok) {
      return c.json({ error: { code: result.error.code, message: result.error.message } }, 500)
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

  router.post('/:id/prompt', validateBody(PromptBodySchema), async (c) => {
    const id = c.req.param('id')
    let record = sessions.get(id)
    if (!record) {
      return c.json({ error: { code: 'SESSION_NOT_FOUND', message: `Session '${id}' not found` } }, 404)
    }

    const { prompt } = c.get('validatedBody') as { prompt: string }

    // Auto-restart if settings changed since session started
    const dbRow = store.findById(id)
    if (dbRow && settingsStore && record.startedWithSettings) {
      const currentEffective = settingsStore.getEffectiveSettings(record.workspacePath)
      if (settingsChanged(record.startedWithSettings, currentEffective)) {
        try {
          const resolvedModel = normalizeModel(currentEffective.model)

          await svc.injectHooks(record.workspacePath)

          const startResult = await svc.wireAndStart({
            sessionId: id,
            workspacePath: record.workspacePath,
            createdAt: record.createdAt,
            settings: currentEffective,
            startOpts: {
              prompt,
              sessionId: dbRow.cli_session_id ?? undefined,
              model: resolvedModel,
              effortLevel: currentEffective.effortLevel,
              maxTurns: currentEffective.maxTurns,
              maxBudgetUsd: currentEffective.maxBudgetUsd,
              appendSystemPrompt: currentEffective.appendSystemPrompt,
              addDirs: currentEffective.addDirs,
              disallowedTools: currentEffective.disallowedTools,
              chromeEnabled: currentEffective.chromeEnabled,
              permissionMode: resolvePermissionMode(currentEffective.permissionMode),
            },
          })

          if (!startResult.ok) {
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

    workspaceLogger?.log(record.workspacePath, { type: 'session_prompt', sessionId: id, data: { sessionId: id, prompt } })

    return c.json({ success: true })
  })

  router.post('/:id/cancel', async (c) => {
    const id = c.req.param('id')
    const record = sessions.get(id)
    if (!record) {
      return c.json({ error: { code: 'SESSION_NOT_FOUND', message: `Session '${id}' not found` } }, 404)
    }

    await record.process.cancel()
    workspaceLogger?.log(record.workspacePath, { type: 'session_cancel', sessionId: id, data: { sessionId: id } })
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
      return c.json({ error: { code: 'SESSION_NOT_FOUND', message: `Session '${id}' not found` } }, 404)
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
        return c.json({ error: { code: result.error.code, message: result.error.message } }, 404)
      }
      return c.json({ error: { code: result.error.code, message: result.error.message } }, 500)
    }

    return c.json({ messages: result.value, offset, limit })
  })

  return router
}
