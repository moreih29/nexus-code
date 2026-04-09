import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'

import {
  normalizePath,
  isProtected,
  isWithinAllowedRoots,
  extractPaths,
} from '../path-guard.js'
import { allowFixtures } from './bash-parser-fixtures.js'
import { unparseableFixtures } from './bash-parser-fixtures.js'
import { protectedFixtures } from './protected-paths-fixtures.js'

// ---------------------------------------------------------------------------
// Test workspace setup
// ---------------------------------------------------------------------------

let tmpDir: string
let symlinkTarget: string
let symlinkPath: string

beforeAll(async () => {
  tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'path-guard-test-'))
  // Create a real file for symlink target
  symlinkTarget = path.join(tmpDir, 'real-file.txt')
  await fs.promises.writeFile(symlinkTarget, 'content')
  // Create a symlink pointing to it
  symlinkPath = path.join(tmpDir, 'link-to-file.txt')
  await fs.promises.symlink(symlinkTarget, symlinkPath)
})

afterAll(async () => {
  await fs.promises.rm(tmpDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// normalizePath — 6 scenarios
// ---------------------------------------------------------------------------

describe('normalizePath', () => {
  it('returns absolute path unchanged when given an absolute path that exists', async () => {
    const result = await normalizePath(tmpDir, '/')
    expect(path.isAbsolute(result)).toBe(true)
  })

  it('resolves relative path against cwd', async () => {
    const result = await normalizePath('some-dir/file.txt', tmpDir)
    expect(result).toBe(path.join(tmpDir, 'some-dir', 'file.txt'))
  })

  it('expands leading ~ to home directory', async () => {
    const result = await normalizePath('~/some-path', '/')
    expect(result.startsWith(os.homedir())).toBe(true)
    expect(result).toBe(path.join(os.homedir(), 'some-path'))
  })

  it('follows symlinks when path exists', async () => {
    const result = await normalizePath(symlinkPath, '/')
    // On macOS, /var/folders resolves to /private/var/folders via realpath
    const expectedRealTarget = await fs.promises.realpath(symlinkTarget)
    expect(result).toBe(expectedRealTarget)
  })

  it('resolves parent directory via realpath when file does not exist (ENOENT)', async () => {
    const nonExistent = path.join(tmpDir, 'nonexistent-file.txt')
    const result = await normalizePath(nonExistent, '/')
    // Parent (tmpDir) exists, so result should be realpath(tmpDir) + basename
    const expectedParent = await fs.promises.realpath(tmpDir)
    expect(result).toBe(path.join(expectedParent, 'nonexistent-file.txt'))
  })

  it('returns raw resolved path when both file and parent do not exist', async () => {
    const deepNonExistent = path.join(tmpDir, 'no-such-dir', 'no-such-file.txt')
    const result = await normalizePath(deepNonExistent, '/')
    // Parent does not exist either — should return raw resolved path
    expect(result).toBe(deepNonExistent)
  })
})

// ---------------------------------------------------------------------------
// isProtected — fixture-driven it.each (from protected-paths-fixtures.ts)
// ---------------------------------------------------------------------------

describe('isProtected — fixture corpus', () => {
  const workspaceRoot = '/workspace'

  it.each(protectedFixtures)('$desc', ({ rel, expected }) => {
    const absPath = rel.startsWith('..')
      ? path.resolve(workspaceRoot, rel)
      : path.join(workspaceRoot, rel)
    const result = isProtected(absPath, workspaceRoot)
    expect(result).toBe(expected)
  })
})

// Additional isProtected cases not covered by fixtures
describe('isProtected — additional cases', () => {
  const workspaceRoot = '/workspace'

  it('returns false for the workspace root itself', () => {
    expect(isProtected(workspaceRoot, workspaceRoot)).toBe(false)
  })

  it('returns true for .env.test inside workspace', () => {
    expect(isProtected('/workspace/.env.test', workspaceRoot)).toBe(true)
  })

  it('returns true for .git/HEAD', () => {
    expect(isProtected('/workspace/.git/HEAD', workspaceRoot)).toBe(true)
  })

  it('returns true for .nexus/state/tasks.json', () => {
    expect(isProtected('/workspace/.nexus/state/tasks.json', workspaceRoot)).toBe(true)
  })

  it('returns false for .nexus/memory/notes.md (not a protected path)', () => {
    expect(isProtected('/workspace/.nexus/memory/notes.md', workspaceRoot)).toBe(false)
  })

  it('returns true for .gitconfig at workspace root', () => {
    expect(isProtected('/workspace/.gitconfig', workspaceRoot)).toBe(true)
  })

  it('returns true for .mcp.json at workspace root', () => {
    expect(isProtected('/workspace/.mcp.json', workspaceRoot)).toBe(true)
  })

  it('returns false for regular nested source file', () => {
    expect(isProtected('/workspace/packages/shared/src/index.ts', workspaceRoot)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// isWithinAllowedRoots — 4 scenarios
// ---------------------------------------------------------------------------

describe('isWithinAllowedRoots', () => {
  it('returns true when path is directly inside the root', () => {
    expect(isWithinAllowedRoots('/workspace/src/file.ts', ['/workspace'])).toBe(true)
  })

  it('returns false when path is outside all roots', () => {
    expect(isWithinAllowedRoots('/etc/passwd', ['/workspace'])).toBe(false)
  })

  it('returns true when path matches an additional allowed root', () => {
    expect(
      isWithinAllowedRoots('/home/user/project/README.md', ['/workspace', '/home/user/project'])
    ).toBe(true)
  })

  it('returns false when path is the parent of a root, not inside it', () => {
    // /workspace is root; /workspace itself is a child of /, not of /workspace
    // Checking if the root parent is considered "within" the root — should be false
    expect(isWithinAllowedRoots('/home', ['/home/user/project'])).toBe(false)
  })

  it('returns true when path equals the root exactly', () => {
    expect(isWithinAllowedRoots('/workspace', ['/workspace'])).toBe(true)
  })

  it('returns false with empty roots array', () => {
    expect(isWithinAllowedRoots('/workspace/file.ts', [])).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// extractPaths — Edit / Write / MultiEdit / NotebookEdit / Read tools
// ---------------------------------------------------------------------------

describe('extractPaths — structured tools', () => {
  it('Edit: returns paths with file_path', () => {
    expect(extractPaths('Edit', { file_path: '/workspace/src/foo.ts', old_string: 'a', new_string: 'b' }))
      .toEqual({ kind: 'paths', paths: ['/workspace/src/foo.ts'] })
  })

  it('Edit: returns unparseable/parse-error when file_path is missing', () => {
    expect(extractPaths('Edit', { content: 'hello' }))
      .toEqual({ kind: 'unparseable', reason: 'parse-error' })
  })

  it('Write: returns paths with file_path', () => {
    expect(extractPaths('Write', { file_path: '/workspace/README.md', content: 'hello' }))
      .toEqual({ kind: 'paths', paths: ['/workspace/README.md'] })
  })

  it('Write: returns unparseable/parse-error when file_path is not a string', () => {
    expect(extractPaths('Write', { file_path: 42 }))
      .toEqual({ kind: 'unparseable', reason: 'parse-error' })
  })

  it('MultiEdit: returns paths with file_path', () => {
    expect(extractPaths('MultiEdit', { file_path: '/workspace/package.json', edits: [] }))
      .toEqual({ kind: 'paths', paths: ['/workspace/package.json'] })
  })

  it('NotebookEdit: returns paths with file_path', () => {
    expect(extractPaths('NotebookEdit', { file_path: '/workspace/notebook.ipynb', cell_type: 'code' }))
      .toEqual({ kind: 'paths', paths: ['/workspace/notebook.ipynb'] })
  })

  it('Read: returns empty (read-only tool)', () => {
    expect(extractPaths('Read', { file_path: '/workspace/secret.txt' }))
      .toEqual({ kind: 'empty' })
  })

  it('Grep: returns empty (read-only tool)', () => {
    expect(extractPaths('Grep', { pattern: 'foo', path: '/workspace' }))
      .toEqual({ kind: 'empty' })
  })

  it('Glob: returns empty (read-only tool)', () => {
    expect(extractPaths('Glob', { pattern: '**/*.ts' }))
      .toEqual({ kind: 'empty' })
  })

  it('NotebookRead: returns empty (read-only tool)', () => {
    expect(extractPaths('NotebookRead', { file_path: '/workspace/nb.ipynb' }))
      .toEqual({ kind: 'empty' })
  })

  it('unknown tool: returns empty (default case)', () => {
    expect(extractPaths('UnknownTool', { something: 'irrelevant' }))
      .toEqual({ kind: 'empty' })
  })
})

// ---------------------------------------------------------------------------
// extractPaths — Bash allow fixtures (it.each)
// ---------------------------------------------------------------------------

describe('extractPaths — Bash allow fixtures', () => {
  it.each(allowFixtures)('$desc', ({ command, expectedPaths }) => {
    const result = extractPaths('Bash', { command })
    expect(result).toEqual({ kind: 'paths', paths: expectedPaths })
  })
})

// ---------------------------------------------------------------------------
// extractPaths — Bash unparseable fixtures (it.each)
// ---------------------------------------------------------------------------

describe('extractPaths — Bash unparseable fixtures', () => {
  it.each(unparseableFixtures)('$desc', ({ command, expectedReason }) => {
    const result = extractPaths('Bash', { command })
    expect(result).toEqual({ kind: 'unparseable', reason: expectedReason })
  })
})

// ---------------------------------------------------------------------------
// extractPaths — Bash additional edge cases
// ---------------------------------------------------------------------------

describe('extractPaths — Bash additional edge cases', () => {
  it('empty command returns empty', () => {
    expect(extractPaths('Bash', { command: '' }))
      .toEqual({ kind: 'empty' })
  })

  it('whitespace-only command returns empty', () => {
    expect(extractPaths('Bash', { command: '   ' }))
      .toEqual({ kind: 'empty' })
  })

  it('Bash with missing command field returns unparseable/parse-error', () => {
    expect(extractPaths('Bash', {}))
      .toEqual({ kind: 'unparseable', reason: 'parse-error' })
  })

  it('sed without -i flag returns unparseable/unknown-command (read-only)', () => {
    expect(extractPaths('Bash', { command: "sed 's/a/b/' foo.txt" }))
      .toEqual({ kind: 'unparseable', reason: 'unknown-command' })
  })

  it('rm without any path returns empty', () => {
    expect(extractPaths('Bash', { command: 'rm -rf' }))
      .toEqual({ kind: 'empty' })
  })

  it('mkdir with no args returns empty', () => {
    expect(extractPaths('Bash', { command: 'mkdir' }))
      .toEqual({ kind: 'empty' })
  })

  it('cp with single arg (no destination) returns a single path', () => {
    // cp only has one non-flag arg — the parser still collects it
    expect(extractPaths('Bash', { command: 'cp src.ts' }))
      .toEqual({ kind: 'paths', paths: ['src.ts'] })
  })

  it('unclosed double-quote: tokenizer reads to EOF gracefully, parses as path', () => {
    // Per the fixture comment: unclosed " reads to EOF and emits the word token
    const result = extractPaths('Bash', { command: 'mkdir "foo' })
    expect(result).toEqual({ kind: 'paths', paths: ['foo'] })
  })

  it('sed -i with multiple files collects all files', () => {
    const result = extractPaths('Bash', { command: "sed -i 's/a/b/' file1.txt file2.txt" })
    expect(result).toEqual({ kind: 'paths', paths: ['file1.txt', 'file2.txt'] })
  })

  it('touch with multiple files collects all', () => {
    const result = extractPaths('Bash', { command: 'touch a.ts b.ts c.ts' })
    expect(result).toEqual({ kind: 'paths', paths: ['a.ts', 'b.ts', 'c.ts'] })
  })

  it('rmdir collects path', () => {
    const result = extractPaths('Bash', { command: 'rmdir some/dir' })
    expect(result).toEqual({ kind: 'paths', paths: ['some/dir'] })
  })
})
