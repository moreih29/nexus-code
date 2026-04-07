import { describe, it, expect, beforeEach, vi } from 'vitest'
import { SettingsManager } from '../settings/settings-manager.js'
import type { StoragePort } from '../../ports/storage-port.js'
import { ok, err, appError } from '@nexus/shared'

function makeStoragePort(initialContent?: string): StoragePort & { writes: { path: string; content: string }[] } {
  const writes: { path: string; content: string }[] = []
  let stored = initialContent

  return {
    writes,
    async read(_path) {
      if (stored === undefined) {
        return err(appError('FILE_NOT_FOUND', 'File not found'))
      }
      return ok(stored)
    },
    async write(path, content) {
      writes.push({ path, content })
      stored = content
      return ok(undefined)
    },
  }
}

describe('SettingsManager', () => {
  let storage: ReturnType<typeof makeStoragePort>
  let manager: SettingsManager

  beforeEach(() => {
    storage = makeStoragePort()
    manager = new SettingsManager(storage, '/settings.json')
  })

  describe('load', () => {
    it('loads settings from storage', async () => {
      const storageWithData = makeStoragePort(JSON.stringify({ theme: 'dark', lang: 'ko' }))
      const mgr = new SettingsManager(storageWithData, '/settings.json')
      const result = await mgr.load()
      expect(result.ok).toBe(true)

      const theme = mgr.get('theme')
      expect(theme.ok).toBe(true)
      if (theme.ok) expect(theme.value).toBe('dark')
    })

    it('succeeds with empty cache when file not found', async () => {
      const result = await manager.load()
      expect(result.ok).toBe(true)
    })

    it('returns error when JSON is malformed', async () => {
      const badStorage = makeStoragePort('{ invalid json }')
      const mgr = new SettingsManager(badStorage, '/settings.json')
      const result = await mgr.load()
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.code).toBe('SETTINGS_PARSE_ERROR')
      }
    })
  })

  describe('get', () => {
    it('returns error for missing key', () => {
      const result = manager.get('missing')
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.code).toBe('SETTING_NOT_FOUND')
      }
    })

    it('returns value after set', async () => {
      await manager.set('key', 'value')
      const result = manager.get('key')
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.value).toBe('value')
    })
  })

  describe('set', () => {
    it('persists setting to storage', async () => {
      const result = await manager.set('theme', 'light')
      expect(result.ok).toBe(true)
      expect(storage.writes).toHaveLength(1)
      const written = JSON.parse(storage.writes[0].content) as Record<string, unknown>
      expect(written.theme).toBe('light')
    })

    it('serializes write queue — concurrent writes are serialized', async () => {
      const writeOrder: string[] = []

      // Create a deferred promise we control externally
      let unblockFirst!: () => void
      const firstWriteBlocker = new Promise<void>((resolve) => {
        unblockFirst = resolve
      })

      let writeCount = 0
      const slowStorage: StoragePort = {
        async read() {
          return err(appError('FILE_NOT_FOUND', 'not found'))
        },
        async write(_path, content) {
          const parsed = JSON.parse(content) as Record<string, unknown>
          const keys = Object.keys(parsed).sort().join(',')

          if (writeCount === 0) {
            // Block the first write until we unblock it
            await firstWriteBlocker
          }
          writeCount++
          writeOrder.push(keys)
          return ok(undefined)
        },
      }

      const mgr = new SettingsManager(slowStorage, '/settings.json')

      // Start both writes "concurrently" — second is queued behind first
      const p1 = mgr.set('a', 1)
      const p2 = mgr.set('b', 2)

      // Allow microtasks to progress so both sets are queued before unblocking
      await Promise.resolve()

      // Unblock the first write
      unblockFirst()

      await Promise.all([p1, p2])

      // Both writes serialize the latest cache state (eager cache, serialized writes)
      expect(writeOrder).toHaveLength(2)
      expect(writeOrder[0]).toBe('a,b')
      expect(writeOrder[1]).toBe('a,b')
    })

    it('second write includes value from first write (accumulated state)', async () => {
      await manager.set('a', 1)
      await manager.set('b', 2)

      expect(storage.writes).toHaveLength(2)
      const secondWrite = JSON.parse(storage.writes[1].content) as Record<string, unknown>
      expect(secondWrite.a).toBe(1)
      expect(secondWrite.b).toBe(2)
    })
  })
})
