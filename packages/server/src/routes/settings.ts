import { Hono } from 'hono'
import type { SettingsStore, AppSettings } from '../adapters/db/settings-store.js'

const VALID_KEYS: Set<string> = new Set<keyof AppSettings>([
  'model',
  'effortLevel',
  'permissionMode',
  'maxTurns',
  'maxBudgetUsd',

  'appendSystemPrompt',
  'addDirs',
  'disallowedTools',
  'chromeEnabled',
  'theme',
])

export function createSettingsRouter(store: SettingsStore) {
  const router = new Hono()

  router.get('/', (c) => {
    const scope = c.req.query('scope')
    const workspace = c.req.query('workspace')

    if (scope === 'global') {
      return c.json(store.getGlobalSettings())
    }

    if (scope === 'project') {
      if (!workspace) {
        return c.json(
          { error: { code: 'VALIDATION_ERROR', message: 'Query parameter "workspace" is required for scope=project' } },
          400,
        )
      }
      return c.json(store.getProjectSettings(workspace))
    }

    if (scope === 'effective') {
      if (!workspace) {
        return c.json(
          { error: { code: 'VALIDATION_ERROR', message: 'Query parameter "workspace" is required for scope=effective' } },
          400,
        )
      }
      return c.json(store.getEffectiveSettings(workspace))
    }

    return c.json(
      { error: { code: 'VALIDATION_ERROR', message: 'Query parameter "scope" must be one of: global, project, effective' } },
      400,
    )
  })

  router.put('/', async (c) => {
    const scope = c.req.query('scope')
    const workspace = c.req.query('workspace')

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: { code: 'INVALID_JSON', message: 'Request body must be valid JSON' } }, 400)
    }

    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Request body must be an object' } }, 400)
    }

    const partial = body as Partial<AppSettings>

    if (scope === 'global') {
      const updated = store.updateGlobalSettings(partial)
      return c.json(updated)
    }

    if (scope === 'project') {
      if (!workspace) {
        return c.json(
          { error: { code: 'VALIDATION_ERROR', message: 'Query parameter "workspace" is required for scope=project' } },
          400,
        )
      }
      const updated = store.updateProjectSettings(workspace, partial)
      return c.json(updated)
    }

    return c.json(
      { error: { code: 'VALIDATION_ERROR', message: 'Query parameter "scope" must be one of: global, project' } },
      400,
    )
  })

  router.delete('/project/:key', (c) => {
    const key = c.req.param('key')
    const workspace = c.req.query('workspace')

    if (!workspace) {
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: 'Query parameter "workspace" is required' } },
        400,
      )
    }

    if (!VALID_KEYS.has(key)) {
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: `Unknown settings key: ${key}` } },
        400,
      )
    }

    const updated = store.deleteProjectKey(workspace, key as keyof AppSettings)
    return c.json(updated)
  })

  return router
}
