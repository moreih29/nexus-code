import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import { createGitRouter } from '../git.js'

vi.mock('node:child_process')

import { execSync } from 'node:child_process'

const mockExecSync = execSync as unknown as ReturnType<typeof vi.fn>

function makeApp() {
  const router = createGitRouter()
  const app = new Hono()
  app.route('/', router)
  return app
}

// Helper: build a Buffer-like string return (execSync with encoding returns string)
function gitStr(s: string): string {
  return s
}

describe('git routes', () => {
  let app: Hono

  beforeEach(() => {
    vi.clearAllMocks()
    app = makeApp()
  })

  describe('GET /:path{.+}/git', () => {
    it('returns branch, staged, changes, and commits for a valid git repo', async () => {
      // Call order in createGitRouter -> runGit('rev-parse --abbrev-ref HEAD')
      // then parseStatus: execSync('git status --porcelain'), parseDiffNumstat (x2), parseCommits
      // Note: runGit uses execSync with encoding:'utf8' — returns string directly
      // parseStatus calls execSync('git status --porcelain') - returns string
      // parseDiffNumstat calls runGit('diff --numstat') and runGit('diff --numstat --cached')
      // parseCommits calls runGit('log ...')

      mockExecSync
        .mockReturnValueOnce(gitStr('main'))                         // rev-parse --abbrev-ref HEAD
        .mockReturnValueOnce(gitStr(' M src/app.ts\n'))              // git status --porcelain
        .mockReturnValueOnce(gitStr('5\t2\tsrc/app.ts\n'))           // diff --numstat --cached
        .mockReturnValueOnce(gitStr('3\t1\tsrc/app.ts\n'))           // diff --numstat
        .mockReturnValueOnce(gitStr('abc1234\x1fFix bug\x1f2 hours ago\n'))  // git log

      const res = await app.request('/tmp/workspace/git')
      expect(res.status).toBe(200)
      const body = await res.json() as {
        branch: string
        staged: unknown[]
        changes: unknown[]
        commits: Array<{ hash: string; message: string; date: string }>
      }
      expect(body.branch).toBe('main')
      expect(Array.isArray(body.staged)).toBe(true)
      expect(Array.isArray(body.changes)).toBe(true)
      expect(Array.isArray(body.commits)).toBe(true)
      expect(body.commits[0]?.hash).toBe('abc1234')
    })

    it('returns { error: "not-a-git-repo" } for a non-git directory', async () => {
      mockExecSync.mockImplementation(() => {
        throw new Error('not a git repository')
      })

      const res = await app.request('/tmp/not-git/git')
      expect(res.status).toBe(200)
      const body = await res.json() as { error: string }
      expect(body.error).toBe('not-a-git-repo')
    })
  })

  describe('GET /:path{.+}/git/diff', () => {
    it('returns diff content when file param is provided', async () => {
      const diffOutput = '@@ -1,3 +1,4 @@\n hello\n+world\n'
      mockExecSync.mockReturnValueOnce(gitStr(diffOutput))

      const res = await app.request('/tmp/workspace/git/diff?file=src/app.ts')
      expect(res.status).toBe(200)
      const body = await res.json() as { diff: string }
      expect(typeof body.diff).toBe('string')
      expect(body.diff).toContain('hello')
    })

    it('returns 400 when file param is missing', async () => {
      const res = await app.request('/tmp/workspace/git/diff')
      expect(res.status).toBe(400)
      const body = await res.json() as { error: string }
      expect(body.error).toBe('file param required')
    })

    it('passes --staged flag when staged=true', async () => {
      mockExecSync.mockReturnValueOnce(gitStr('diff content'))

      const res = await app.request('/tmp/workspace/git/diff?file=src/app.ts&staged=true')
      expect(res.status).toBe(200)

      // Verify --staged was passed to execSync
      const callArg = mockExecSync.mock.calls[0]?.[0] as string
      expect(callArg).toContain('--staged')
    })
  })

  describe('GET /:path{.+}/git/show', () => {
    it('returns commit details when hash param is provided', async () => {
      mockExecSync
        .mockReturnValueOnce(gitStr('src/app.ts | 2 ++\n 1 file changed'))  // git show --stat
        .mockReturnValueOnce(gitStr('Fix bug\n\nDetailed description'))      // git log -1 --pretty=format:%B
        .mockReturnValueOnce(gitStr('\nsrc/app.ts\n'))                        // git show --name-only

      const res = await app.request('/tmp/workspace/git/show?hash=abc1234')
      expect(res.status).toBe(200)
      const body = await res.json() as { message: string; files: string[]; stat: string }
      expect(body.message).toContain('Fix bug')
      expect(Array.isArray(body.files)).toBe(true)
      expect(body.files).toContain('src/app.ts')
      expect(typeof body.stat).toBe('string')
    })

    it('returns 400 when hash param is missing', async () => {
      const res = await app.request('/tmp/workspace/git/show')
      expect(res.status).toBe(400)
      const body = await res.json() as { error: string }
      expect(body.error).toBe('hash param required')
    })
  })
})
