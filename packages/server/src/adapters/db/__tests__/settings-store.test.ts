import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { SettingsStore } from '../settings-store.js'

describe('SettingsStore', () => {
  let db: Database.Database
  let store: SettingsStore

  beforeEach(() => {
    db = new Database(':memory:')
    store = new SettingsStore(db)
  })

  describe('global settings', () => {
    it('returns empty object when no settings saved', () => {
      expect(store.getGlobalSettings()).toEqual({})
    })

    it('saves and retrieves global settings', () => {
      store.updateGlobalSettings({ theme: 'monokai-pro', model: 'opus' })
      expect(store.getGlobalSettings()).toEqual({ theme: 'monokai-pro', model: 'opus' })
    })

    it('merges partial updates without losing existing keys', () => {
      store.updateGlobalSettings({ theme: 'monokai-pro', model: 'opus' })
      store.updateGlobalSettings({ theme: 'claude' })
      expect(store.getGlobalSettings()).toEqual({ theme: 'claude', model: 'opus' })
    })

    it('does not create duplicate rows on repeated updates', () => {
      store.updateGlobalSettings({ theme: 'a' })
      store.updateGlobalSettings({ theme: 'b' })
      store.updateGlobalSettings({ theme: 'c' })
      const count = db.prepare(`SELECT COUNT(*) as cnt FROM settings WHERE scope = 'global' AND workspace_path IS NULL`).get() as { cnt: number }
      expect(count.cnt).toBe(1)
    })

    it('round-trips: update then get returns the updated value', () => {
      store.updateGlobalSettings({ theme: 'midnight-blue' })
      store.updateGlobalSettings({ theme: 'monokai-pro' })
      expect(store.getGlobalSettings().theme).toBe('monokai-pro')
    })
  })

  describe('project settings', () => {
    it('returns empty object when no settings saved', () => {
      expect(store.getProjectSettings('/test/path')).toEqual({})
    })

    it('saves and retrieves project settings', () => {
      store.updateProjectSettings('/test/path', { model: 'haiku' })
      expect(store.getProjectSettings('/test/path')).toEqual({ model: 'haiku' })
    })

    it('isolates settings per workspace path', () => {
      store.updateProjectSettings('/path/a', { model: 'opus' })
      store.updateProjectSettings('/path/b', { model: 'haiku' })
      expect(store.getProjectSettings('/path/a').model).toBe('opus')
      expect(store.getProjectSettings('/path/b').model).toBe('haiku')
    })

    it('merges partial updates for the same workspace', () => {
      store.updateProjectSettings('/test', { model: 'opus', theme: 'claude' })
      store.updateProjectSettings('/test', { model: 'sonnet' })
      expect(store.getProjectSettings('/test')).toEqual({ model: 'sonnet', theme: 'claude' })
    })
  })

  describe('effective settings', () => {
    it('returns defaults when nothing saved', () => {
      const effective = store.getEffectiveSettings('/test')
      expect(effective.model).toBe('sonnet')
      expect(effective.effortLevel).toBe('medium')
    })

    it('global overrides defaults', () => {
      store.updateGlobalSettings({ model: 'opus' })
      expect(store.getEffectiveSettings('/test').model).toBe('opus')
    })

    it('project overrides global', () => {
      store.updateGlobalSettings({ model: 'opus' })
      store.updateProjectSettings('/test', { model: 'haiku' })
      expect(store.getEffectiveSettings('/test').model).toBe('haiku')
    })
  })

  describe('deleteProjectKey', () => {
    it('removes a specific key from project settings', () => {
      store.updateProjectSettings('/test', { model: 'opus', theme: 'claude' })
      store.deleteProjectKey('/test', 'model')
      expect(store.getProjectSettings('/test')).toEqual({ theme: 'claude' })
    })
  })
})
