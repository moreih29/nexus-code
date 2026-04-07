import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { HookManager } from '../hook-manager.js'

function makeTempDir(): string {
  return join(tmpdir(), `hook-manager-test-${randomUUID()}`)
}

describe('HookManager', () => {
  let tempDir: string
  let manager: HookManager

  beforeEach(async () => {
    tempDir = makeTempDir()
    await mkdir(tempDir, { recursive: true })
    manager = new HookManager(3000)
  })

  afterEach(async () => {
    // Clean up temp dirs — best effort
    const { rm } = await import('node:fs/promises')
    await rm(tempDir, { recursive: true, force: true })
  })

  describe('validateToken', () => {
    it('validates the correct token', () => {
      const url = manager.getHookUrl()
      const token = new URL(url).searchParams.get('token')!
      expect(manager.validateToken(token)).toBe(true)
    })

    it('rejects an incorrect token', () => {
      expect(manager.validateToken('wrong-token')).toBe(false)
    })
  })

  describe('getHookUrl', () => {
    it('returns URL with correct port', () => {
      const url = manager.getHookUrl()
      expect(url).toContain('http://localhost:3000')
      expect(url).toContain('/hooks/pre-tool-use')
      expect(url).toContain('token=')
    })
  })

  describe('injectHooks', () => {
    it('creates settings.local.json with hook when file does not exist', async () => {
      const result = await manager.injectHooks(tempDir)
      expect(result.ok).toBe(true)

      const settingsPath = join(tempDir, '.claude', 'settings.local.json')
      const raw = await readFile(settingsPath, 'utf8')
      const settings = JSON.parse(raw) as Record<string, unknown>

      expect(settings['hooks']).toBeDefined()
      const hooks = settings['hooks'] as Record<string, unknown>
      expect(Array.isArray(hooks['PreToolUse'])).toBe(true)

      const preToolUse = hooks['PreToolUse'] as unknown[]
      expect(preToolUse.length).toBe(1)

      const group = preToolUse[0] as Record<string, unknown>
      expect(Array.isArray(group['hooks'])).toBe(true)
      const hookEntries = group['hooks'] as Array<Record<string, unknown>>
      expect(hookEntries[0]!['type']).toBe('http')
      expect(typeof hookEntries[0]!['url']).toBe('string')
      expect(hookEntries[0]!['timeout']).toBe(60)
    })

    it('preserves existing settings when injecting', async () => {
      const settingsDir = join(tempDir, '.claude')
      await mkdir(settingsDir, { recursive: true })
      const settingsPath = join(settingsDir, 'settings.local.json')

      const existing = { theme: 'dark', someOtherKey: 42 }
      const { writeFile } = await import('node:fs/promises')
      await writeFile(settingsPath, JSON.stringify(existing), 'utf8')

      await manager.injectHooks(tempDir)

      const raw = await readFile(settingsPath, 'utf8')
      const settings = JSON.parse(raw) as Record<string, unknown>
      expect(settings['theme']).toBe('dark')
      expect(settings['someOtherKey']).toBe(42)
      expect(settings['hooks']).toBeDefined()
    })

    it('does not inject duplicate hooks on repeated calls', async () => {
      await manager.injectHooks(tempDir)
      await manager.injectHooks(tempDir)

      const settingsPath = join(tempDir, '.claude', 'settings.local.json')
      const raw = await readFile(settingsPath, 'utf8')
      const settings = JSON.parse(raw) as Record<string, unknown>
      const hooks = settings['hooks'] as Record<string, unknown>
      const preToolUse = hooks['PreToolUse'] as unknown[]
      expect(preToolUse.length).toBe(1)
    })

    it('merges with existing PreToolUse hooks', async () => {
      const settingsDir = join(tempDir, '.claude')
      await mkdir(settingsDir, { recursive: true })
      const settingsPath = join(settingsDir, 'settings.local.json')

      const existing = {
        hooks: {
          PreToolUse: [
            { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] },
          ],
        },
      }
      const { writeFile } = await import('node:fs/promises')
      await writeFile(settingsPath, JSON.stringify(existing), 'utf8')

      await manager.injectHooks(tempDir)

      const raw = await readFile(settingsPath, 'utf8')
      const settings = JSON.parse(raw) as Record<string, unknown>
      const hooks = settings['hooks'] as Record<string, unknown>
      const preToolUse = hooks['PreToolUse'] as unknown[]
      expect(preToolUse.length).toBe(2)
    })
  })

  describe('removeHooks', () => {
    it('removes injected hooks from settings.local.json', async () => {
      await manager.injectHooks(tempDir)
      const result = await manager.removeHooks(tempDir)
      expect(result.ok).toBe(true)

      const settingsPath = join(tempDir, '.claude', 'settings.local.json')
      const raw = await readFile(settingsPath, 'utf8')
      const settings = JSON.parse(raw) as Record<string, unknown>
      expect(settings['hooks']).toBeUndefined()
    })

    it('handles removal when file does not exist', async () => {
      const result = await manager.removeHooks(tempDir)
      expect(result.ok).toBe(true)
    })

    it('preserves non-nexus hooks when removing', async () => {
      const settingsDir = join(tempDir, '.claude')
      await mkdir(settingsDir, { recursive: true })
      const settingsPath = join(settingsDir, 'settings.local.json')

      const existing = {
        hooks: {
          PreToolUse: [
            { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] },
          ],
        },
      }
      const { writeFile } = await import('node:fs/promises')
      await writeFile(settingsPath, JSON.stringify(existing), 'utf8')

      await manager.injectHooks(tempDir)
      await manager.removeHooks(tempDir)

      const raw = await readFile(settingsPath, 'utf8')
      const settings = JSON.parse(raw) as Record<string, unknown>
      const hooks = settings['hooks'] as Record<string, unknown>
      const preToolUse = hooks['PreToolUse'] as unknown[]
      expect(preToolUse.length).toBe(1)
      const group = preToolUse[0] as Record<string, unknown>
      const hookEntries = group['hooks'] as Array<Record<string, unknown>>
      expect(hookEntries[0]!['type']).toBe('command')
    })
  })

  describe('removeAllHooks', () => {
    it('removes hooks from all active workspaces', async () => {
      const dir2 = makeTempDir()
      await mkdir(dir2, { recursive: true })

      await manager.injectHooks(tempDir)
      await manager.injectHooks(dir2)
      await manager.removeAllHooks()

      const settingsPath1 = join(tempDir, '.claude', 'settings.local.json')
      const settingsPath2 = join(dir2, '.claude', 'settings.local.json')

      const raw1 = await readFile(settingsPath1, 'utf8')
      const raw2 = await readFile(settingsPath2, 'utf8')

      const s1 = JSON.parse(raw1) as Record<string, unknown>
      const s2 = JSON.parse(raw2) as Record<string, unknown>

      expect(s1['hooks']).toBeUndefined()
      expect(s2['hooks']).toBeUndefined()

      const { rm } = await import('node:fs/promises')
      await rm(dir2, { recursive: true, force: true })
    })
  })
})
