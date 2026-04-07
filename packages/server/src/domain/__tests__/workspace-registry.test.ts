import { describe, it, expect, beforeEach } from 'vitest'
import { WorkspaceRegistry } from '../workspace/workspace-registry.js'
import { Agent } from '../agent/agent.js'
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

  describe('Workspace agent management', () => {
    it('adds an agent to a workspace', () => {
      registry.add({ id: 'ws-1', path: '/home/user/project' })
      const wsResult = registry.get('/home/user/project')
      expect(wsResult.ok).toBe(true)
      if (!wsResult.ok) return

      const agent = new Agent({ id: 'agent-1', type: 'engineer', status: 'idle', workspacePath: '/home/user/project' })
      const addResult = wsResult.value.addAgent(agent)
      expect(addResult.ok).toBe(true)
    })

    it('retrieves an agent from a workspace', () => {
      registry.add({ id: 'ws-1', path: '/home/user/project' })
      const wsResult = registry.get('/home/user/project')
      if (!wsResult.ok) return

      const agent = new Agent({ id: 'agent-1', type: 'engineer', status: 'idle', workspacePath: '/home/user/project' })
      wsResult.value.addAgent(agent)

      const getResult = wsResult.value.getAgent('agent-1')
      expect(getResult.ok).toBe(true)
      if (getResult.ok) {
        expect(getResult.value.id).toBe('agent-1')
      }
    })

    it('removes an agent from a workspace', () => {
      registry.add({ id: 'ws-1', path: '/home/user/project' })
      const wsResult = registry.get('/home/user/project')
      if (!wsResult.ok) return

      const agent = new Agent({ id: 'agent-1', type: 'engineer', status: 'idle', workspacePath: '/home/user/project' })
      wsResult.value.addAgent(agent)
      const removeResult = wsResult.value.removeAgent('agent-1')
      expect(removeResult.ok).toBe(true)

      const listResult = wsResult.value.listAgents()
      expect(listResult.ok).toBe(true)
      if (listResult.ok) {
        expect(listResult.value).toHaveLength(0)
      }
    })

    it('returns error when adding agent with mismatched workspacePath', () => {
      registry.add({ id: 'ws-1', path: '/home/user/project' })
      const wsResult = registry.get('/home/user/project')
      if (!wsResult.ok) return

      const agent = new Agent({ id: 'agent-1', type: 'engineer', status: 'idle', workspacePath: '/other/path' })
      const addResult = wsResult.value.addAgent(agent)
      expect(addResult.ok).toBe(false)
      if (!addResult.ok) {
        expect(addResult.error.code).toBe('AGENT_WORKSPACE_MISMATCH')
      }
    })

    it('returns error when adding duplicate agent', () => {
      registry.add({ id: 'ws-1', path: '/home/user/project' })
      const wsResult = registry.get('/home/user/project')
      if (!wsResult.ok) return

      const agent = new Agent({ id: 'agent-1', type: 'engineer', status: 'idle', workspacePath: '/home/user/project' })
      wsResult.value.addAgent(agent)
      const addResult = wsResult.value.addAgent(agent)
      expect(addResult.ok).toBe(false)
      if (!addResult.ok) {
        expect(addResult.error.code).toBe('AGENT_ALREADY_EXISTS')
      }
    })
  })
})
