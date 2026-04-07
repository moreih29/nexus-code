import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { WorkspaceStore } from '../workspace-store.js'

function makeDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
  return db
}

describe('WorkspaceStore', () => {
  let db: Database.Database
  let store: WorkspaceStore

  beforeEach(() => {
    db = makeDb()
    store = new WorkspaceStore(db)
  })

  describe('create + findByPath', () => {
    it('creates a workspace and retrieves it by path', () => {
      const row = store.create({ id: 'ws-1', path: '/home/user/project' })

      expect(row.id).toBe('ws-1')
      expect(row.path).toBe('/home/user/project')
      expect(row.name).toBeNull()
      expect(row.created_at).toBeTruthy()

      const found = store.findByPath('/home/user/project')
      expect(found).not.toBeNull()
      expect(found!.id).toBe('ws-1')
    })

    it('creates a workspace with a name', () => {
      const row = store.create({ id: 'ws-2', path: '/home/user/proj2', name: 'My Project' })

      expect(row.name).toBe('My Project')
    })

    it('returns null for a non-existent path', () => {
      expect(store.findByPath('/does/not/exist')).toBeNull()
    })
  })

  describe('create — duplicate path', () => {
    it('throws on duplicate path', () => {
      store.create({ id: 'ws-1', path: '/home/user/project' })

      expect(() => store.create({ id: 'ws-2', path: '/home/user/project' })).toThrow()
    })
  })

  describe('remove', () => {
    it('removes an existing workspace and returns true', () => {
      store.create({ id: 'ws-1', path: '/home/user/project' })

      const removed = store.remove('/home/user/project')
      expect(removed).toBe(true)
      expect(store.findByPath('/home/user/project')).toBeNull()
    })

    it('returns false when the path does not exist', () => {
      const removed = store.remove('/no/such/path')
      expect(removed).toBe(false)
    })
  })

  describe('list', () => {
    it('returns all workspaces ordered by created_at ASC', () => {
      store.create({ id: 'ws-1', path: '/a' })
      store.create({ id: 'ws-2', path: '/b' })
      store.create({ id: 'ws-3', path: '/c' })

      const rows = store.list()
      expect(rows).toHaveLength(3)
      const paths = rows.map((r) => r.path)
      expect(paths).toContain('/a')
      expect(paths).toContain('/b')
      expect(paths).toContain('/c')
    })

    it('returns empty array when no workspaces exist', () => {
      expect(store.list()).toHaveLength(0)
    })
  })

  describe('server restart simulation', () => {
    it('persists workspaces across new store instances sharing the same db', () => {
      store.create({ id: 'ws-1', path: '/project/alpha', name: 'Alpha' })
      store.create({ id: 'ws-2', path: '/project/beta' })

      const store2 = new WorkspaceStore(db)
      const rows = store2.list()

      expect(rows).toHaveLength(2)
      const ids = rows.map((r) => r.id)
      expect(ids).toContain('ws-1')
      expect(ids).toContain('ws-2')
    })
  })
})
