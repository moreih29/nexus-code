import { describe, it, expect } from 'vitest'
import { realpathSync } from 'node:fs'
import { workspacePathToId } from '../workspace-id.js'
import { getSessionFilePath } from '../../adapters/claude-code/history-parser.js'

describe('workspacePathToId', () => {
  it('replaces slashes with dashes', () => {
    expect(workspacePathToId('/Users/kih/foo')).toBe('-Users-kih-foo')
  })

  it('handles path with no trailing slash', () => {
    expect(workspacePathToId('/Users/kih/workspaces/project')).toBe('-Users-kih-workspaces-project')
  })

  it('handles path with trailing slash', () => {
    expect(workspacePathToId('/Users/kih/project/')).toBe('-Users-kih-project-')
  })

  it('handles root path', () => {
    expect(workspacePathToId('/')).toBe('-')
  })

  it('handles single segment path', () => {
    expect(workspacePathToId('/tmp')).toBe('-tmp')
  })

  it('handles deeply nested path', () => {
    expect(workspacePathToId('/a/b/c/d/e')).toBe('-a-b-c-d-e')
  })

  it('handles path with dots', () => {
    expect(workspacePathToId('/Users/kih/.nexus-code')).toBe('-Users-kih-.nexus-code')
  })

  it('handles path with spaces', () => {
    expect(workspacePathToId('/Users/kih/my project')).toBe('-Users-kih-my project')
  })

  it('handles path with numbers', () => {
    expect(workspacePathToId('/Users/kih/project123')).toBe('-Users-kih-project123')
  })

  it('handles path with underscores', () => {
    expect(workspacePathToId('/Users/kih/my_project')).toBe('-Users-kih-my_project')
  })

  it('handles path with hyphens in segment names', () => {
    expect(workspacePathToId('/Users/kih/nexus-code')).toBe('-Users-kih-nexus-code')
  })

  it('handles empty string', () => {
    expect(workspacePathToId('')).toBe('')
  })
})

describe('workspacePathToId matches history-parser.getSessionFilePath encoding', () => {
  it('produces identical encoding for /Users/kih/foo', () => {
    const wsPath = '/Users/kih/foo'
    const wid = workspacePathToId(wsPath)
    // getSessionFilePath encodes via resolvedPath.replace(/\//g, '-')
    const sessionFilePath = getSessionFilePath(wsPath, 'test-session')
    // Extract the encoded segment from the path: ~/.claude/projects/{encoded}/test-session.jsonl
    const match = sessionFilePath.match(/\.claude\/projects\/(.+)\/test-session\.jsonl$/)
    expect(match).not.toBeNull()
    const historyEncoded = match![1]!
    expect(wid).toBe(historyEncoded)
  })

  it('produces identical encoding for /Users/kih/workspaces/areas/nexus-code', () => {
    const wsPath = '/Users/kih/workspaces/areas/nexus-code'
    const wid = workspacePathToId(wsPath)
    const sessionFilePath = getSessionFilePath(wsPath, 'test-session')
    const match = sessionFilePath.match(/\.claude\/projects\/(.+)\/test-session\.jsonl$/)
    expect(match).not.toBeNull()
    const historyEncoded = match![1]!
    expect(wid).toBe(historyEncoded)
  })

  it('produces identical encoding for /tmp', () => {
    // /tmp on macOS may be a symlink — use realpath to match history-parser behavior
    let resolvedTmp = '/tmp'
    try { resolvedTmp = realpathSync('/tmp') } catch { /* ignore */ }
    const wid = workspacePathToId(resolvedTmp)
    const sessionFilePath = getSessionFilePath(resolvedTmp, 'test-session')
    const match = sessionFilePath.match(/\.claude\/projects\/(.+)\/test-session\.jsonl$/)
    expect(match).not.toBeNull()
    const historyEncoded = match![1]!
    expect(wid).toBe(historyEncoded)
  })
})
