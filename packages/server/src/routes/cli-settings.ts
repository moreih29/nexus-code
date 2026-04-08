import { Hono } from 'hono'
import { getCliSettingsPath, readCliSettings, writeCliSettings, CLI_SETTINGS_WHITELIST } from '../adapters/cli/cli-settings-proxy.js'

export function createCliSettingsRouter() {
  const router = new Hono()

  router.get('/', async (c) => {
    const scope = c.req.query('scope')
    const workspace = c.req.query('workspace')

    if (scope !== 'global' && scope !== 'project') {
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: 'Query parameter "scope" must be one of: global, project' } },
        400,
      )
    }

    if (scope === 'project' && !workspace) {
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: 'Query parameter "workspace" is required for scope=project' } },
        400,
      )
    }

    const filePath = getCliSettingsPath(scope, workspace)
    const settings = await readCliSettings(filePath)
    return c.json(settings)
  })

  router.put('/', async (c) => {
    const scope = c.req.query('scope')
    const workspace = c.req.query('workspace')

    if (scope !== 'global' && scope !== 'project') {
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: 'Query parameter "scope" must be one of: global, project' } },
        400,
      )
    }

    if (scope === 'project' && !workspace) {
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: 'Query parameter "workspace" is required for scope=project' } },
        400,
      )
    }

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: { code: 'INVALID_JSON', message: 'Request body must be valid JSON' } }, 400)
    }

    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Request body must be an object' } }, 400)
    }

    const updates = body as Record<string, unknown>

    // Reject requests that include non-whitelisted keys
    const disallowedKeys = Object.keys(updates).filter((k) => !(CLI_SETTINGS_WHITELIST as readonly string[]).includes(k))
    if (disallowedKeys.length > 0) {
      return c.json(
        {
          error: {
            code: 'VALIDATION_ERROR',
            message: `The following keys are not allowed: ${disallowedKeys.join(', ')}. Allowed keys: ${CLI_SETTINGS_WHITELIST.join(', ')}`,
          },
        },
        400,
      )
    }

    const filePath = getCliSettingsPath(scope, workspace)

    try {
      await writeCliSettings(filePath, updates)
    } catch (cause) {
      console.error('Failed to write CLI settings:', cause)
      return c.json({ error: { code: 'WRITE_FAILED', message: 'Failed to write CLI settings file' } }, 500)
    }

    const updated = await readCliSettings(filePath)
    return c.json(updated)
  })

  return router
}
