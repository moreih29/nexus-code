import { randomUUID } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { ok, err, appError } from '@nexus/shared'
import type { Result } from '@nexus/shared'

const HOOK_URL_MARKER = 'nexus-server-hook'

export class HookManager {
  private readonly hookToken: string
  private readonly activeWorkspaces = new Set<string>()
  private readonly port: number

  constructor(port: number) {
    this.hookToken = randomUUID()
    this.port = port
  }

  getHookUrl(): string {
    return `http://localhost:${this.port}/hooks/pre-tool-use?token=${this.hookToken}&marker=${HOOK_URL_MARKER}`
  }

  validateToken(token: string): boolean {
    return token === this.hookToken
  }

  getActiveWorkspaceCount(): number {
    return this.activeWorkspaces.size
  }

  async injectHooks(workspacePath: string): Promise<Result<void>> {
    const settingsPath = join(workspacePath, '.claude', 'settings.local.json')

    let settings: Record<string, unknown> = {}
    try {
      const raw = await readFile(settingsPath, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed === 'object' && parsed !== null) {
        settings = parsed as Record<string, unknown>
      }
    } catch {
      // File doesn't exist or is invalid JSON — start fresh
    }

    const hookEntry = {
      type: 'http',
      url: this.getHookUrl(),
      timeout: 300,
    }

    const existingHooks = settings['hooks']
    let hooks: Record<string, unknown[]> = {}
    if (typeof existingHooks === 'object' && existingHooks !== null && !Array.isArray(existingHooks)) {
      hooks = existingHooks as Record<string, unknown[]>
    }

    const preToolUse = hooks['PreToolUse']
    const existingGroup = Array.isArray(preToolUse) ? preToolUse : []

    const currentHookUrl = this.getHookUrl()

    // Remove any nexus hook entries that don't match the current token (stale from previous server run)
    const withoutStaleNexusHooks = existingGroup.filter((entry) => {
      if (typeof entry !== 'object' || entry === null) return true
      const e = entry as Record<string, unknown>
      if (!Array.isArray(e['hooks'])) return true
      const hasStaleNexusHook = (e['hooks'] as unknown[]).some((h) => {
        if (typeof h !== 'object' || h === null) return false
        const hh = h as Record<string, unknown>
        return typeof hh['url'] === 'string' && hh['url'].includes(HOOK_URL_MARKER) && hh['url'] !== currentHookUrl
      })
      return !hasStaleNexusHook
    })

    // Check if the current-token hook is already present
    const alreadyInjected = withoutStaleNexusHooks.some((entry) => {
      if (typeof entry !== 'object' || entry === null) return false
      const e = entry as Record<string, unknown>
      if (!Array.isArray(e['hooks'])) return false
      return (e['hooks'] as unknown[]).some((h) => {
        if (typeof h !== 'object' || h === null) return false
        const hh = h as Record<string, unknown>
        return typeof hh['url'] === 'string' && hh['url'] === currentHookUrl
      })
    })

    if (!alreadyInjected) {
      withoutStaleNexusHooks.push({ matcher: '', hooks: [hookEntry] })
    }

    if (withoutStaleNexusHooks.length === 0) {
      delete hooks['PreToolUse']
    } else {
      hooks['PreToolUse'] = withoutStaleNexusHooks
    }

    if (Object.keys(hooks).length === 0) {
      delete settings['hooks']
    } else {
      settings['hooks'] = hooks
    }

    try {
      await mkdir(dirname(settingsPath), { recursive: true })
      await writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf8')
    } catch (cause) {
      return err(appError('HOOK_INJECT_FAILED', `Failed to write settings at '${settingsPath}'`, { cause }))
    }

    this.activeWorkspaces.add(workspacePath)
    return ok(undefined)
  }

  async removeHooks(workspacePath: string): Promise<Result<void>> {
    const settingsPath = join(workspacePath, '.claude', 'settings.local.json')

    let settings: Record<string, unknown> = {}
    try {
      const raw = await readFile(settingsPath, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed === 'object' && parsed !== null) {
        settings = parsed as Record<string, unknown>
      }
    } catch {
      // Nothing to clean up
      this.activeWorkspaces.delete(workspacePath)
      return ok(undefined)
    }

    const existingHooks = settings['hooks']
    if (typeof existingHooks !== 'object' || existingHooks === null || Array.isArray(existingHooks)) {
      this.activeWorkspaces.delete(workspacePath)
      return ok(undefined)
    }

    const hooks = existingHooks as Record<string, unknown>
    const preToolUse = hooks['PreToolUse']
    if (!Array.isArray(preToolUse)) {
      this.activeWorkspaces.delete(workspacePath)
      return ok(undefined)
    }

    const filtered = preToolUse.filter((entry) => {
      if (typeof entry !== 'object' || entry === null) return true
      const e = entry as Record<string, unknown>
      if (!Array.isArray(e['hooks'])) return true
      const hasOurHook = (e['hooks'] as unknown[]).some((h) => {
        if (typeof h !== 'object' || h === null) return false
        const hh = h as Record<string, unknown>
        return typeof hh['url'] === 'string' && hh['url'].includes(HOOK_URL_MARKER)
      })
      return !hasOurHook
    })

    if (filtered.length === 0) {
      delete hooks['PreToolUse']
    } else {
      hooks['PreToolUse'] = filtered
    }

    if (Object.keys(hooks).length === 0) {
      delete settings['hooks']
    }

    try {
      await writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf8')
    } catch (cause) {
      return err(appError('HOOK_REMOVE_FAILED', `Failed to write settings at '${settingsPath}'`, { cause }))
    }

    this.activeWorkspaces.delete(workspacePath)
    return ok(undefined)
  }

  async removeAllHooks(): Promise<void> {
    const workspaces = Array.from(this.activeWorkspaces)
    await Promise.allSettled(workspaces.map((ws) => this.removeHooks(ws)))
  }

  async cleanupOrphanHooks(workspacePaths: string[]): Promise<void> {
    await Promise.allSettled(workspacePaths.map((wsPath) => this._cleanupOrphanHooksForWorkspace(wsPath)))
  }

  private async _cleanupOrphanHooksForWorkspace(workspacePath: string): Promise<void> {
    const settingsPath = join(workspacePath, '.claude', 'settings.local.json')

    let settings: Record<string, unknown>
    try {
      const raw = await readFile(settingsPath, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed !== 'object' || parsed === null) return
      settings = parsed as Record<string, unknown>
    } catch {
      return
    }

    const existingHooks = settings['hooks']
    if (typeof existingHooks !== 'object' || existingHooks === null || Array.isArray(existingHooks)) {
      return
    }

    const hooks = existingHooks as Record<string, unknown>
    const preToolUse = hooks['PreToolUse']
    if (!Array.isArray(preToolUse)) return

    const currentHookUrl = this.getHookUrl()

    const filtered = preToolUse.filter((entry) => {
      if (typeof entry !== 'object' || entry === null) return true
      const e = entry as Record<string, unknown>
      if (!Array.isArray(e['hooks'])) return true
      const hasOrphanNexusHook = (e['hooks'] as unknown[]).some((h) => {
        if (typeof h !== 'object' || h === null) return false
        const hh = h as Record<string, unknown>
        if (typeof hh['url'] !== 'string') return false
        return hh['url'].includes(HOOK_URL_MARKER) && hh['url'] !== currentHookUrl
      })
      return !hasOrphanNexusHook
    })

    if (filtered.length === preToolUse.length) return

    if (filtered.length === 0) {
      delete hooks['PreToolUse']
    } else {
      hooks['PreToolUse'] = filtered
    }

    if (Object.keys(hooks).length === 0) {
      delete settings['hooks']
    }

    try {
      await writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf8')
    } catch {
      // Best-effort cleanup — ignore write failures
    }
  }
}
