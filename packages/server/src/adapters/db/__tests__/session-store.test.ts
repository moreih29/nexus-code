import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { SessionStore } from '../session-store.js'

describe('SessionStore', () => {
  let store: SessionStore

  beforeEach(() => {
    store = new SessionStore(':memory:')
  })

  afterEach(() => {
    store.close()
  })

  describe('create + findById', () => {
    it('creates a session and retrieves it by id', () => {
      const row = store.create({
        id: 'sess-1',
        workspacePath: '/home/user/project',
        agentId: 'agent-1',
      })

      expect(row.id).toBe('sess-1')
      expect(row.workspace_path).toBe('/home/user/project')
      expect(row.agent_id).toBe('agent-1')
      expect(row.status).toBe('idle')
      expect(row.cli_session_id).toBeNull()
      expect(row.model).toBeNull()
      expect(row.permission_mode).toBeNull()
      expect(row.prompt).toBeNull()
      expect(row.ended_at).toBeNull()
      expect(row.error_message).toBeNull()
      expect(row.exit_code).toBeNull()

      const found = store.findById('sess-1')
      expect(found).not.toBeNull()
      expect(found!.id).toBe('sess-1')
    })

    it('creates a session with optional fields', () => {
      const row = store.create({
        id: 'sess-2',
        workspacePath: '/home/user/project',
        agentId: 'agent-2',
        status: 'running',
        model: 'claude-opus-4',
        permissionMode: 'auto',
        prompt: 'Hello world',
      })

      expect(row.status).toBe('running')
      expect(row.model).toBe('claude-opus-4')
      expect(row.permission_mode).toBe('auto')
      expect(row.prompt).toBe('Hello world')
    })

    it('returns null for non-existent id', () => {
      expect(store.findById('does-not-exist')).toBeNull()
    })
  })

  describe('updateCliSessionId', () => {
    it('sets cli_session_id on an existing session', () => {
      store.create({ id: 'sess-1', workspacePath: '/p', agentId: 'a-1' })
      store.updateCliSessionId('sess-1', 'cli-abc-123')

      const row = store.findById('sess-1')
      expect(row!.cli_session_id).toBe('cli-abc-123')
    })
  })

  describe('updateStatus', () => {
    it('updates the status field', () => {
      store.create({ id: 'sess-1', workspacePath: '/p', agentId: 'a-1' })
      store.updateStatus('sess-1', 'running')

      const row = store.findById('sess-1')
      expect(row!.status).toBe('running')
    })
  })

  describe('markEnded', () => {
    it('marks a session as stopped with exit code 0', () => {
      store.create({ id: 'sess-1', workspacePath: '/p', agentId: 'a-1' })
      store.markEnded('sess-1', 0, null)

      const row = store.findById('sess-1')
      expect(row!.status).toBe('stopped')
      expect(row!.exit_code).toBe(0)
      expect(row!.error_message).toBeNull()
      expect(row!.ended_at).not.toBeNull()
    })

    it('marks a session as error with error message', () => {
      store.create({ id: 'sess-1', workspacePath: '/p', agentId: 'a-1' })
      store.markEnded('sess-1', 1, 'Process crashed')

      const row = store.findById('sess-1')
      expect(row!.status).toBe('error')
      expect(row!.exit_code).toBe(1)
      expect(row!.error_message).toBe('Process crashed')
      expect(row!.ended_at).not.toBeNull()
    })
  })

  describe('listByWorkspace', () => {
    it('returns sessions for the given workspace sorted by created_at DESC', () => {
      store.create({ id: 'sess-1', workspacePath: '/ws', agentId: 'a-1' })
      store.create({ id: 'sess-2', workspacePath: '/ws', agentId: 'a-2' })
      store.create({ id: 'sess-3', workspacePath: '/other', agentId: 'a-3' })

      const rows = store.listByWorkspace('/ws')
      expect(rows).toHaveLength(2)
      const ids = rows.map((r) => r.id)
      expect(ids).toContain('sess-1')
      expect(ids).toContain('sess-2')
      expect(ids).not.toContain('sess-3')
    })

    it('respects the limit parameter', () => {
      for (let i = 0; i < 5; i++) {
        store.create({ id: `sess-${i}`, workspacePath: '/ws', agentId: `a-${i}` })
      }

      const rows = store.listByWorkspace('/ws', 3)
      expect(rows).toHaveLength(3)
    })

    it('returns empty array when no sessions exist for workspace', () => {
      const rows = store.listByWorkspace('/nonexistent')
      expect(rows).toHaveLength(0)
    })
  })

  describe('getLatest', () => {
    it('returns the most recently created session for the workspace', () => {
      store.create({ id: 'sess-1', workspacePath: '/ws', agentId: 'a-1' })
      store.create({ id: 'sess-2', workspacePath: '/ws', agentId: 'a-2' })

      const latest = store.getLatest('/ws')
      expect(latest).not.toBeNull()
      expect(['sess-1', 'sess-2']).toContain(latest!.id)
    })

    it('returns null when no sessions exist for workspace', () => {
      expect(store.getLatest('/nonexistent')).toBeNull()
    })
  })

  describe('updateSettings', () => {
    it('updates model field', () => {
      store.create({ id: 'sess-1', workspacePath: '/p', agentId: 'a-1', model: 'claude-opus-4' })
      store.updateSettings('sess-1', { model: 'claude-sonnet-4' })

      const row = store.findById('sess-1')
      expect(row!.model).toBe('claude-sonnet-4')
    })

    it('updates permission_mode field', () => {
      store.create({ id: 'sess-1', workspacePath: '/p', agentId: 'a-1', permissionMode: 'default' })
      store.updateSettings('sess-1', { permissionMode: 'auto' })

      const row = store.findById('sess-1')
      expect(row!.permission_mode).toBe('auto')
    })

    it('updates both model and permissionMode together', () => {
      store.create({ id: 'sess-1', workspacePath: '/p', agentId: 'a-1' })
      store.updateSettings('sess-1', { model: 'claude-sonnet-4', permissionMode: 'bypassPermissions' })

      const row = store.findById('sess-1')
      expect(row!.model).toBe('claude-sonnet-4')
      expect(row!.permission_mode).toBe('bypassPermissions')
    })

    it('does nothing when called with empty settings', () => {
      store.create({ id: 'sess-1', workspacePath: '/p', agentId: 'a-1', model: 'claude-opus-4' })
      store.updateSettings('sess-1', {})

      const row = store.findById('sess-1')
      expect(row!.model).toBe('claude-opus-4')
    })
  })

  describe('close', () => {
    it('closes the database without throwing', () => {
      expect(() => store.close()).not.toThrow()
    })
  })
})
