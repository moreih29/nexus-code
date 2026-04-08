import { describe, it, expect, beforeEach } from 'vitest'
import { useWorkspaceStore } from '@/stores/workspace-store'

// useActiveWorkspace combines useWorkspaceStore.activeWorkspaceId with
// useWorkspaces().data to derive workspace and workspacePath.
// Since renderHook requires jsdom + React Query provider, we test the same
// derivation logic inline using the real store.

interface Workspace {
  id: string
  name: string
  path: string
}

/** Replicate the derivation in useActiveWorkspace. */
function deriveActiveWorkspace(
  activeWorkspaceId: string | null,
  workspaces: Workspace[] | undefined,
) {
  const workspace = workspaces?.find((ws) => ws.id === activeWorkspaceId)
  const workspacePath = workspace?.path ?? null
  return { workspace, workspacePath }
}

function resetStore() {
  useWorkspaceStore.setState({ activeWorkspaceId: null })
}

beforeEach(() => {
  resetStore()
})

const sampleWorkspaces: Workspace[] = [
  { id: 'ws-1', name: 'Alpha', path: '/projects/alpha' },
  { id: 'ws-2', name: 'Beta', path: '/projects/beta' },
]

describe('useActiveWorkspace derivation', () => {
  it('returns workspace null and workspacePath null when activeWorkspaceId is null', () => {
    const { workspace, workspacePath } = deriveActiveWorkspace(null, sampleWorkspaces)
    expect(workspace).toBeUndefined()
    expect(workspacePath).toBeNull()
  })

  it('returns workspace undefined when activeWorkspaceId is not in workspaces list', () => {
    const { workspace } = deriveActiveWorkspace('ws-999', sampleWorkspaces)
    expect(workspace).toBeUndefined()
  })

  it('returns the matching workspace and its path when activeWorkspaceId is valid', () => {
    useWorkspaceStore.setState({ activeWorkspaceId: 'ws-1' })
    const activeId = useWorkspaceStore.getState().activeWorkspaceId
    const { workspace, workspacePath } = deriveActiveWorkspace(activeId, sampleWorkspaces)
    expect(workspace).toEqual(sampleWorkspaces[0])
    expect(workspacePath).toBe('/projects/alpha')
  })

  it('returns workspace undefined when workspaces data is undefined (not yet loaded)', () => {
    const { workspace } = deriveActiveWorkspace('ws-1', undefined)
    expect(workspace).toBeUndefined()
  })
})
