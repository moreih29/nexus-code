import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'

export const CLI_SETTINGS_WHITELIST = ['permissions', 'language', 'alwaysThinkingEnabled'] as const
type WhitelistedKey = (typeof CLI_SETTINGS_WHITELIST)[number]

export type CliSettings = {
  permissions?: {
    allow?: string[]
    deny?: string[]
  }
  language?: string
  alwaysThinkingEnabled?: boolean
}

export function getCliSettingsPath(scope: 'global' | 'project', workspacePath?: string): string {
  if (scope === 'global') {
    return join(homedir(), '.claude', 'settings.json')
  }
  if (!workspacePath) {
    throw new Error('workspacePath is required for project scope')
  }
  return join(workspacePath, '.claude', 'settings.json')
}

export async function readCliSettings(filePath: string): Promise<CliSettings> {
  let raw: string
  try {
    raw = await readFile(filePath, 'utf8')
  } catch {
    return {}
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {}
  }

  const full = parsed as Record<string, unknown>
  const result: CliSettings = {}

  if (typeof full['language'] === 'string') {
    result.language = full['language']
  }

  if (typeof full['alwaysThinkingEnabled'] === 'boolean') {
    result.alwaysThinkingEnabled = full['alwaysThinkingEnabled']
  }

  const perms = full['permissions']
  if (typeof perms === 'object' && perms !== null && !Array.isArray(perms)) {
    const p = perms as Record<string, unknown>
    const allow = Array.isArray(p['allow']) ? (p['allow'] as unknown[]).filter((v): v is string => typeof v === 'string') : undefined
    const deny = Array.isArray(p['deny']) ? (p['deny'] as unknown[]).filter((v): v is string => typeof v === 'string') : undefined
    if (allow !== undefined || deny !== undefined) {
      result.permissions = {}
      if (allow !== undefined) result.permissions.allow = allow
      if (deny !== undefined) result.permissions.deny = deny
    }
  }

  return result
}

// Per-file write queue to prevent concurrent write races
const writeQueues = new Map<string, Promise<void>>()

export async function writeCliSettings(filePath: string, updates: Record<string, unknown>): Promise<void> {
  const previous = writeQueues.get(filePath) ?? Promise.resolve()
  const next = previous.then(() => _doWrite(filePath, updates))
  writeQueues.set(filePath, next.catch(() => {}))
  return next
}

async function _doWrite(filePath: string, updates: Record<string, unknown>): Promise<void> {
  let existing: Record<string, unknown> = {}
  try {
    const raw = await readFile(filePath, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      existing = parsed as Record<string, unknown>
    }
  } catch {
    // File missing or invalid JSON — start fresh, preserving nothing
  }

  // Apply only whitelisted keys
  const merged = { ...existing }
  for (const key of CLI_SETTINGS_WHITELIST) {
    if (Object.prototype.hasOwnProperty.call(updates, key)) {
      merged[key] = updates[key as WhitelistedKey]
    }
  }

  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, JSON.stringify(merged, null, 2), 'utf8')
}
