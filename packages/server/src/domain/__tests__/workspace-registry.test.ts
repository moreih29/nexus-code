import { describe, it, expect, beforeEach } from 'vitest'
import { WorkspaceRegistry } from '../workspace/workspace-registry.js'
import type { EventPort } from '../../ports/event-port.js'

function makeEventPort(): EventPort & { events: { event: string; data: unknown }[] } {
  const events: { event: string; data: unknown }[] = []
  return {
    events,
    emit(event, data) {
      events.push({ event, data })
    },
    on(_event, _handler) {
      return () => {}
    },
  }
}

describe('WorkspaceRegistry', () => {
  let registry: WorkspaceRegistry
  let eventPort: ReturnType<typeof makeEventPort>

  beforeEach(() => {
    eventPort = makeEventPort()
    registry = new WorkspaceRegistry(eventPort)
  })

  describe('add', () => {
    it('adds a workspace and returns it', () => {
      const result = registry.add({ id: 'ws-1', path: '/home/user/project' })
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.value.id).toBe('ws-1')
        expect(result.value.path).toBe('/home/user/project')
      }
    })

    it('emits workspace:added event', () => {
      registry.add({ id: 'ws-1', path: '/home/user/project' })
      expect(eventPort.events).toHaveLength(1)
      expect(eventPort.events[0].event).toBe('workspace:added')
    })

    it('returns error when workspace path already exists', () => {
      registry.add({ id: 'ws-1', path: '/home/user/project' })
      const result = registry.add({ id: 'ws-2', path: '/home/user/project' })
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.code).toBe('WORKSPACE_ALREADY_EXISTS')
      }
    })
  })

  describe('remove', () => {
    it('removes an existing workspace', () => {
      registry.add({ id: 'ws-1', path: '/home/user/project' })
      const result = registry.remove('/home/user/project')
      expect(result.ok).toBe(true)
    })

    it('emits workspace:removed event', () => {
      registry.add({ id: 'ws-1', path: '/home/user/project' })
      eventPort.events.length = 0
      registry.remove('/home/user/project')
      expect(eventPort.events[0].event).toBe('workspace:removed')
    })

    it('returns error when workspace not found', () => {
      const result = registry.remove('/nonexistent')
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.code).toBe('WORKSPACE_NOT_FOUND')
      }
    })
  })

  describe('get', () => {
    it('retrieves an existing workspace', () => {
      registry.add({ id: 'ws-1', path: '/home/user/project', name: 'My Project' })
      const result = registry.get('/home/user/project')
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.value.name).toBe('My Project')
      }
    })

    it('returns error when workspace not found', () => {
      const result = registry.get('/nonexistent')
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.code).toBe('WORKSPACE_NOT_FOUND')
      }
    })
  })

  describe('list', () => {
    it('returns empty array when no workspaces', () => {
      const result = registry.list()
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.value).toHaveLength(0)
      }
    })

    it('returns all registered workspaces', () => {
      registry.add({ id: 'ws-1', path: '/home/user/project-a' })
      registry.add({ id: 'ws-2', path: '/home/user/project-b' })
      const result = registry.list()
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.value).toHaveLength(2)
      }
    })
  })
})
