import { describe, it, expect, beforeEach } from 'vitest'
import { useWorkspaceStore } from '../workspace-store'

function resetStore() {
  useWorkspaceStore.setState({ activeWorkspaceId: null })
}

beforeEach(() => {
  resetStore()
})

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

describe('initial state', () => {
  it('activeWorkspaceId is null', () => {
    expect(useWorkspaceStore.getState().activeWorkspaceId).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// setActiveWorkspace
// ---------------------------------------------------------------------------

describe('setActiveWorkspace', () => {
  it('sets activeWorkspaceId to the given id', () => {
    useWorkspaceStore.getState().setActiveWorkspace('ws-1')
    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe('ws-1')
  })
})

// ---------------------------------------------------------------------------
// setActiveByIndex
// ---------------------------------------------------------------------------

describe('setActiveByIndex', () => {
  it('sets activeWorkspaceId for a valid index', () => {
    useWorkspaceStore.getState().setActiveByIndex(1, ['ws-a', 'ws-b', 'ws-c'])
    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe('ws-b')
  })

  it('does not change activeWorkspaceId when index is out of bounds', () => {
    useWorkspaceStore.setState({ activeWorkspaceId: 'ws-original' })
    useWorkspaceStore.getState().setActiveByIndex(5, ['ws-a', 'ws-b'])
    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe('ws-original')
  })

  it('does not change activeWorkspaceId when workspaceIds is empty', () => {
    useWorkspaceStore.setState({ activeWorkspaceId: 'ws-original' })
    useWorkspaceStore.getState().setActiveByIndex(0, [])
    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe('ws-original')
  })
})
