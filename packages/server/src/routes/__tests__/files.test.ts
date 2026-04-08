import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import { createFilesRouter } from '../files.js'

vi.mock('node:child_process')
vi.mock('node:fs')

import { execSync } from 'node:child_process'
import { readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs'

const mockExecSync = execSync as unknown as ReturnType<typeof vi.fn>
const mockStatSync = statSync as unknown as ReturnType<typeof vi.fn>
const mockReadFileSync = readFileSync as unknown as ReturnType<typeof vi.fn>
const mockOpenSync = openSync as unknown as ReturnType<typeof vi.fn>
const mockReadSync = readSync as unknown as ReturnType<typeof vi.fn>
const mockCloseSync = closeSync as unknown as ReturnType<typeof vi.fn>

function makeApp() {
  const router = createFilesRouter()
  const app = new Hono()
  app.route('/', router)
  return app
}

describe('files routes', () => {
  let app: Hono

  beforeEach(() => {
    vi.clearAllMocks()
    app = makeApp()
  })

  describe('GET /:path{.+}/files/content', () => {
    it('returns file content for a normal text file', async () => {
      const fileContent = 'hello world\nline 2'
      mockStatSync.mockReturnValue({ isFile: () => true, size: fileContent.length })
      mockReadFileSync.mockReturnValue(fileContent)

      const res = await app.request('/tmp/workspace/files/content?filePath=src/index.ts')
      expect(res.status).toBe(200)
      const body = await res.json() as { content: string; language: string }
      expect(body.content).toBe(fileContent)
      expect(body.language).toBe('typescript')
    })

    it('returns { binary: true, size } for binary extensions like .png', async () => {
      mockStatSync.mockReturnValue({ isFile: () => true, size: 4096 })

      const res = await app.request('/tmp/workspace/files/content?filePath=image.png')
      expect(res.status).toBe(200)
      const body = await res.json() as { binary: boolean; size: number }
      expect(body.binary).toBe(true)
      expect(body.size).toBe(4096)
    })

    it('returns truncated content with notice when file exceeds 1MB', async () => {
      const bigSize = 1024 * 1024 + 100
      mockStatSync.mockReturnValue({ isFile: () => true, size: bigSize })
      mockOpenSync.mockReturnValue(3)
      mockReadSync.mockImplementation((_fd: number, buffer: Buffer) => {
        buffer.fill(65) // fill with 'A'
        return buffer.length
      })
      mockCloseSync.mockReturnValue(undefined)

      const res = await app.request('/tmp/workspace/files/content?filePath=large.txt')
      expect(res.status).toBe(200)
      const body = await res.json() as { content: string }
      expect(body.content).toContain('처음 1MB만 표시합니다')
    })

    it('blocks path traversal (403) when filePath escapes workspace', async () => {
      // filePath with ../ — join would produce a path outside the workspace
      // The check is: absolutePath.startsWith(workspacePath)
      // workspace = /tmp/workspace, filePath = ../../etc/passwd
      // join('/tmp/workspace', '../../etc/passwd') = /etc/passwd  -> does NOT start with /tmp/workspace
      const res = await app.request('/tmp/workspace/files/content?filePath=../../etc/passwd')
      expect(res.status).toBe(403)
      const body = await res.json() as { error: string }
      expect(body.error).toBe('Access denied')
    })

    it('returns 400 when filePath query param is missing', async () => {
      const res = await app.request('/tmp/workspace/files/content')
      expect(res.status).toBe(400)
      const body = await res.json() as { error: string }
      expect(body.error).toContain('filePath')
    })
  })

  describe('GET /:path{.+}/files', () => {
    it('returns file list from git ls-files', async () => {
      mockExecSync
        .mockReturnValueOnce(Buffer.from('true\n'))  // git rev-parse
        .mockReturnValueOnce(Buffer.from('src/index.ts\nsrc/app.ts\n'))  // git ls-files
        .mockReturnValueOnce(Buffer.from(' M src/index.ts\n'))  // git status --porcelain

      const res = await app.request('/tmp/workspace/files')
      expect(res.status).toBe(200)
      const body = await res.json() as { files: Array<{ path: string; status?: string }> }
      expect(Array.isArray(body.files)).toBe(true)
      expect(body.files.length).toBeGreaterThan(0)
      expect(body.files[0]?.path).toBe('src/index.ts')
    })

    it('returns empty files array when not a git repo', async () => {
      mockExecSync.mockImplementation(() => {
        throw new Error('not a git repo')
      })

      const res = await app.request('/tmp/workspace/files')
      expect(res.status).toBe(200)
      const body = await res.json() as { files: unknown[] }
      expect(body.files).toHaveLength(0)
    })
  })
})
