import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('@/api/client', () => ({
  apiClient: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
}))

import { apiClient } from '@/api/client'
import {
  fetchWorkspaces,
  createWorkspace,
  deleteWorkspace,
  fetchFiles,
  fetchGitInfo,
  fetchGitDiff,
  fetchGitShow,
  fetchFileContent,
} from '../workspace'

const mockGet = apiClient.get as ReturnType<typeof vi.fn>
const mockPost = apiClient.post as ReturnType<typeof vi.fn>
const mockDelete = apiClient.delete as ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// fetchWorkspaces
// ---------------------------------------------------------------------------

describe('fetchWorkspaces', () => {
  it('GETs /api/workspaces and returns the workspaces array', async () => {
    const workspaces = [{ path: '/a' }, { path: '/b' }]
    mockGet.mockResolvedValue({ workspaces })

    const result = await fetchWorkspaces()

    expect(mockGet).toHaveBeenCalledWith('/api/workspaces')
    expect(result).toEqual(workspaces)
  })
})

// ---------------------------------------------------------------------------
// createWorkspace
// ---------------------------------------------------------------------------

describe('createWorkspace', () => {
  it('POSTs to /api/workspaces with the request body', async () => {
    const body = { path: '/new/ws' }
    const response = { path: '/new/ws', name: 'ws' }
    mockPost.mockResolvedValue(response)

    const result = await createWorkspace(body as Parameters<typeof createWorkspace>[0])

    expect(mockPost).toHaveBeenCalledWith('/api/workspaces', body)
    expect(result).toEqual(response)
  })
})

// ---------------------------------------------------------------------------
// deleteWorkspace
// ---------------------------------------------------------------------------

describe('deleteWorkspace', () => {
  it('uses encodeURIComponent for the workspace path in URL', async () => {
    mockDelete.mockResolvedValue(undefined)

    await deleteWorkspace('/my/work space')

    const encoded = encodeURIComponent('/my/work space')
    expect(mockDelete).toHaveBeenCalledWith(`/api/workspaces/${encoded}`)
  })
})

// ---------------------------------------------------------------------------
// fetchFiles
// ---------------------------------------------------------------------------

describe('fetchFiles', () => {
  it('uses encodeWorkspacePath (strips leading slash) in URL path segment', async () => {
    mockGet.mockResolvedValue({ files: [] })

    await fetchFiles('/my/project')

    // encodeWorkspacePath strips leading '/', so '/my/project' -> 'my/project'
    expect(mockGet).toHaveBeenCalledWith('/api/workspaces/my/project/files')
  })
})

// ---------------------------------------------------------------------------
// fetchGitInfo
// ---------------------------------------------------------------------------

describe('fetchGitInfo', () => {
  it('uses encodeWorkspacePath for the workspace path', async () => {
    const gitInfo = { branch: 'main', staged: [], changes: [], commits: [] }
    mockGet.mockResolvedValue(gitInfo)

    const result = await fetchGitInfo('/repo/path')

    expect(mockGet).toHaveBeenCalledWith('/api/workspaces/repo/path/git')
    expect(result).toEqual(gitInfo)
  })
})

// ---------------------------------------------------------------------------
// fetchGitDiff
// ---------------------------------------------------------------------------

describe('fetchGitDiff', () => {
  it('passes file and staged as query parameters', async () => {
    mockGet.mockResolvedValue({ diff: '--- a/file\n+++ b/file\n' })

    await fetchGitDiff('/my/repo', 'src/index.ts', true)

    const params = new URLSearchParams({ file: 'src/index.ts', staged: 'true' })
    expect(mockGet).toHaveBeenCalledWith(`/api/workspaces/my/repo/git/diff?${params}`)
  })
})

// ---------------------------------------------------------------------------
// fetchGitShow
// ---------------------------------------------------------------------------

describe('fetchGitShow', () => {
  it('passes hash as query parameter', async () => {
    const response = { message: 'fix: bug', files: ['a.ts'], stat: '1 file' }
    mockGet.mockResolvedValue(response)

    const result = await fetchGitShow('/my/repo', 'abc1234')

    const params = new URLSearchParams({ hash: 'abc1234' })
    expect(mockGet).toHaveBeenCalledWith(`/api/workspaces/my/repo/git/show?${params}`)
    expect(result).toEqual(response)
  })
})

// ---------------------------------------------------------------------------
// fetchFileContent
// ---------------------------------------------------------------------------

describe('fetchFileContent', () => {
  it('passes filePath as query parameter', async () => {
    mockGet.mockResolvedValue({ content: 'hello', language: 'typescript' })

    await fetchFileContent('/my/repo', 'src/app.ts')

    const params = new URLSearchParams({ filePath: 'src/app.ts' })
    expect(mockGet).toHaveBeenCalledWith(`/api/workspaces/my/repo/files/content?${params}`)
  })
})

// ---------------------------------------------------------------------------
// Encoding consistency — deleteWorkspace vs others
// ---------------------------------------------------------------------------

describe('encoding consistency', () => {
  it('deleteWorkspace uses encodeURIComponent (percent-encoding) while fetchFiles uses encodeWorkspacePath (slash-pass-through)', async () => {
    mockDelete.mockResolvedValue(undefined)
    mockGet.mockResolvedValue({ files: [] })

    const path = '/some/workspace'
    await deleteWorkspace(path)
    await fetchFiles(path)

    // deleteWorkspace encodes with encodeURIComponent: '/' becomes '%2F'
    const deleteCall = (mockDelete as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
    expect(deleteCall).toContain('%2F')

    // fetchFiles uses encodeWorkspacePath: leading '/' stripped, rest passed through
    const getCall = (mockGet as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
    expect(getCall).not.toContain('%2F')
    expect(getCall).toContain('/api/workspaces/some/workspace/files')
  })
})
