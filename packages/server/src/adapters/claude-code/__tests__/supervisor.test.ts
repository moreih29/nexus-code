import { describe, it, expect, vi, beforeEach } from 'vitest'
import { WorkspaceGroup } from '../workspace-group.js'
import { ProcessSupervisor } from '../process-supervisor.js'
import type { CliProcess } from '../cli-process.js'
import type { CliProcessFactory } from '../workspace-group.js'

function makeMockProcess(): CliProcess {
  return {
    getStatus: vi.fn().mockReturnValue('idle'),
    start: vi.fn(),
    sendPrompt: vi.fn(),
    cancel: vi.fn(),
    dispose: vi.fn(),
    on: vi.fn().mockReturnValue(() => {}),
  } as unknown as CliProcess
}

describe('WorkspaceGroup', () => {
  let group: WorkspaceGroup
  let factory: CliProcessFactory

  beforeEach(() => {
    factory = vi.fn<CliProcessFactory>().mockImplementation(() => makeMockProcess())
    group = new WorkspaceGroup('/workspace/a', 3, factory)
  })

  it('creates a process for an agent', () => {
    const result = group.createProcess('agent-1')
    expect(result.ok).toBe(true)
    expect(factory).toHaveBeenCalledWith('agent-1')
  })

  it('returns the created process via getProcess', () => {
    group.createProcess('agent-1')
    const process_ = group.getProcess('agent-1')
    expect(process_).toBeDefined()
  })

  it('lists all created processes', () => {
    group.createProcess('agent-1')
    group.createProcess('agent-2')
    expect(group.listProcesses()).toHaveLength(2)
  })

  it('returns error when creating duplicate agent', () => {
    group.createProcess('agent-1')
    const result = group.createProcess('agent-1')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('PROCESS_ALREADY_EXISTS')
    }
  })

  it('returns error when process limit is exceeded', () => {
    group.createProcess('agent-1')
    group.createProcess('agent-2')
    group.createProcess('agent-3')
    const result = group.createProcess('agent-4')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('WORKSPACE_PROCESS_LIMIT')
    }
  })

  it('removes a process and disposes it', () => {
    group.createProcess('agent-1')
    const process_ = group.getProcess('agent-1')!
    group.removeProcess('agent-1')

    expect(process_.dispose).toHaveBeenCalled()
    expect(group.getProcess('agent-1')).toBeUndefined()
  })

  it('removeProcess is a no-op for unknown agentId', () => {
    expect(() => group.removeProcess('unknown')).not.toThrow()
  })

  it('dispose calls dispose on all processes and clears the map', () => {
    group.createProcess('agent-1')
    group.createProcess('agent-2')
    const p1 = group.getProcess('agent-1')!
    const p2 = group.getProcess('agent-2')!

    group.dispose()

    expect(p1.dispose).toHaveBeenCalled()
    expect(p2.dispose).toHaveBeenCalled()
    expect(group.listProcesses()).toHaveLength(0)
  })

  it('getProcessCount returns correct count', () => {
    expect(group.getProcessCount()).toBe(0)
    group.createProcess('agent-1')
    expect(group.getProcessCount()).toBe(1)
    group.createProcess('agent-2')
    expect(group.getProcessCount()).toBe(2)
  })
})

describe('ProcessSupervisor', () => {
  let supervisor: ProcessSupervisor
  let factory: CliProcessFactory

  beforeEach(() => {
    factory = vi.fn<CliProcessFactory>().mockImplementation(() => makeMockProcess())
    supervisor = new ProcessSupervisor(5, 3, factory)
  })

  it('creates a workspace group', () => {
    const result = supervisor.createGroup('/workspace/a')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.workspacePath).toBe('/workspace/a')
    }
  })

  it('returns error when creating duplicate group', () => {
    supervisor.createGroup('/workspace/a')
    const result = supervisor.createGroup('/workspace/a')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('GROUP_ALREADY_EXISTS')
    }
  })

  it('retrieves a group via getGroup', () => {
    supervisor.createGroup('/workspace/a')
    const group = supervisor.getGroup('/workspace/a')
    expect(group).toBeDefined()
  })

  it('returns undefined for unknown workspace', () => {
    expect(supervisor.getGroup('/unknown')).toBeUndefined()
  })

  it('lists all groups', () => {
    supervisor.createGroup('/workspace/a')
    supervisor.createGroup('/workspace/b')
    expect(supervisor.listGroups()).toHaveLength(2)
  })

  it('removes a group and disposes it', () => {
    supervisor.createGroup('/workspace/a')
    const group = supervisor.getGroup('/workspace/a')!
    const disposeSpy = vi.spyOn(group, 'dispose')

    supervisor.removeGroup('/workspace/a')

    expect(disposeSpy).toHaveBeenCalled()
    expect(supervisor.getGroup('/workspace/a')).toBeUndefined()
  })

  it('removeGroup is a no-op for unknown workspace', () => {
    expect(() => supervisor.removeGroup('/unknown')).not.toThrow()
  })

  describe('global process count', () => {
    it('counts processes across all groups', () => {
      supervisor.createGroup('/workspace/a')
      supervisor.createGroup('/workspace/b')
      supervisor.createProcessInGroup('/workspace/a', 'agent-1')
      supervisor.createProcessInGroup('/workspace/a', 'agent-2')
      supervisor.createProcessInGroup('/workspace/b', 'agent-3')

      expect(supervisor.getGlobalProcessCount()).toBe(3)
    })

    it('returns error when global process limit is exceeded', () => {
      supervisor.createGroup('/workspace/a')
      supervisor.createGroup('/workspace/b')

      // Fill up to global limit of 5
      supervisor.createProcessInGroup('/workspace/a', 'agent-1')
      supervisor.createProcessInGroup('/workspace/a', 'agent-2')
      supervisor.createProcessInGroup('/workspace/a', 'agent-3')
      supervisor.createProcessInGroup('/workspace/b', 'agent-4')
      supervisor.createProcessInGroup('/workspace/b', 'agent-5')

      const result = supervisor.createProcessInGroup('/workspace/b', 'agent-6')
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.code).toBe('GLOBAL_PROCESS_LIMIT')
      }
    })

    it('returns error when group does not exist', () => {
      const result = supervisor.createProcessInGroup('/unknown', 'agent-1')
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.code).toBe('GROUP_NOT_FOUND')
      }
    })
  })

  describe('hierarchical dispose', () => {
    it('dispose calls dispose on all groups', () => {
      supervisor.createGroup('/workspace/a')
      supervisor.createGroup('/workspace/b')
      const groupA = supervisor.getGroup('/workspace/a')!
      const groupB = supervisor.getGroup('/workspace/b')!
      const spyA = vi.spyOn(groupA, 'dispose')
      const spyB = vi.spyOn(groupB, 'dispose')

      supervisor.dispose()

      expect(spyA).toHaveBeenCalled()
      expect(spyB).toHaveBeenCalled()
      expect(supervisor.listGroups()).toHaveLength(0)
    })

    it('supervisor.dispose() triggers process dispose through the hierarchy', () => {
      supervisor.createGroup('/workspace/a')
      supervisor.createProcessInGroup('/workspace/a', 'agent-1')
      supervisor.createProcessInGroup('/workspace/a', 'agent-2')

      const group = supervisor.getGroup('/workspace/a')!
      const p1 = group.getProcess('agent-1')!
      const p2 = group.getProcess('agent-2')!

      supervisor.dispose()

      expect(p1.dispose).toHaveBeenCalled()
      expect(p2.dispose).toHaveBeenCalled()
    })
  })
})
