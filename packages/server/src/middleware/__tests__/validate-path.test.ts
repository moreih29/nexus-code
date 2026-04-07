import { describe, it, expect } from 'vitest'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { validateWorkspacePath } from '../validate-path.js'

function makeTempDir(): string {
  return join(tmpdir(), `validate-path-test-${randomUUID()}`)
}

describe('validateWorkspacePath', () => {
  it('accepts a valid absolute directory path', async () => {
    const dir = makeTempDir()
    await mkdir(dir, { recursive: true })

    try {
      const result = await validateWorkspacePath(dir)
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.value).toBe(dir)
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects a relative path', async () => {
    const result = await validateWorkspacePath('relative/path')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_PATH')
      expect(result.error.message).toMatch(/absolute/)
    }
  })

  it('rejects a path that does not exist', async () => {
    const result = await validateWorkspacePath('/tmp/nexus-nonexistent-' + randomUUID())
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_PATH')
      expect(result.error.message).toMatch(/does not exist/)
    }
  })

  it('rejects a path that is a file, not a directory', async () => {
    const dir = makeTempDir()
    await mkdir(dir, { recursive: true })
    const filePath = join(dir, 'somefile.txt')
    await writeFile(filePath, 'hello')

    try {
      const result = await validateWorkspacePath(filePath)
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.code).toBe('INVALID_PATH')
        expect(result.error.message).toMatch(/not a directory/)
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('resolves paths with .. segments', async () => {
    const dir = makeTempDir()
    await mkdir(dir, { recursive: true })

    try {
      const withDotDot = join(dir, 'subdir', '..') + '/'
      const result = await validateWorkspacePath(withDotDot)
      expect(result.ok).toBe(true)
      if (result.ok) {
        // resolved value should not contain ..
        expect(result.value).not.toContain('..')
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
