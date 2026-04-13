import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkspaceLogger } from '../workspace-logger.js'

let _seq = 0
function makeTempDir(): string {
  const dir = join(tmpdir(), `nexus-wl-test-${process.pid}-${Date.now()}-${_seq++}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

async function flushMicrotasks(): Promise<void> {
  // Give the fire-and-forget promise time to settle
  await new Promise((resolve) => setTimeout(resolve, 50))
}

describe('WorkspaceLogger', () => {
  let tmpLogDir: string
  let originalEnv: string | undefined
  let originalNodeEnv: string | undefined

  beforeEach(() => {
    tmpLogDir = makeTempDir()
    originalEnv = process.env['NEXUS_LOG_DIR']
    originalNodeEnv = process.env['NODE_ENV']
    // Force active mode
    process.env['NODE_ENV'] = 'development'
    process.env['NEXUS_LOG_DIR'] = tmpLogDir
  })

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env['NEXUS_LOG_DIR']
    } else {
      process.env['NEXUS_LOG_DIR'] = originalEnv
    }
    if (originalNodeEnv === undefined) {
      delete process.env['NODE_ENV']
    } else {
      process.env['NODE_ENV'] = originalNodeEnv
    }
    rmSync(tmpLogDir, { recursive: true, force: true })
  })

  it('writes a jsonl entry to NEXUS_LOG_DIR/{workspace-id}/{date}.jsonl', async () => {
    const logger = new WorkspaceLogger()
    logger.log('/Users/kih/foo', { type: 'session_start', sessionId: 'sess-1', data: { prompt: 'hello' } })
    await flushMicrotasks()

    const wsId = '-Users-kih-foo'
    const wsDir = join(tmpLogDir, wsId)
    const files = readdirSync(wsDir)
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/^\d{4}-\d{2}-\d{2}\.jsonl$/)

    const content = readFileSync(join(wsDir, files[0]!), 'utf-8')
    const lines = content.trim().split('\n').filter(Boolean)
    expect(lines).toHaveLength(1)
    const parsed = JSON.parse(lines[0]!)
    expect(parsed.type).toBe('session_start')
    expect(parsed.sessionId).toBe('sess-1')
    expect(parsed.workspaceId).toBe(wsId)
    expect(parsed.ts).toBeDefined()
  })

  it('includes requestId in the log entry when provided', async () => {
    const logger = new WorkspaceLogger()
    logger.log('/Users/kih/foo', { type: 'hook_request', sessionId: 'sess-2', requestId: 'req-abc', data: { tool_name: 'Bash' } })
    await flushMicrotasks()

    const wsDir = join(tmpLogDir, '-Users-kih-foo')
    const files = readdirSync(wsDir)
    const content = readFileSync(join(wsDir, files[0]!), 'utf-8')
    const parsed = JSON.parse(content.trim())
    expect(parsed.requestId).toBe('req-abc')
  })

  it('uses NEXUS_LOG_DIR env override', async () => {
    const altDir = makeTempDir()
    try {
      process.env['NEXUS_LOG_DIR'] = altDir
      const logger = new WorkspaceLogger()
      logger.log('/tmp/proj', { type: 'session_cancel', data: {} })
      await flushMicrotasks()

      const wsId = '-tmp-proj'
      const wsDir = join(altDir, wsId)
      const files = readdirSync(wsDir)
      expect(files).toHaveLength(1)
    } finally {
      rmSync(altDir, { recursive: true, force: true })
    }
  })

  it('does not create the old .nexus/logs path', async () => {
    const logger = new WorkspaceLogger()
    logger.log('/Users/kih/foo', { type: 'session_start', data: {} })
    await flushMicrotasks()

    // The workspace path itself should NOT have .nexus/logs created in it
    const oldPath = join('/Users/kih/foo', '.nexus', 'logs')
    let exists = false
    try {
      readdirSync(oldPath)
      exists = true
    } catch {
      exists = false
    }
    expect(exists).toBe(false)
  })

  it('appends multiple entries to the same file', async () => {
    const logger = new WorkspaceLogger()
    logger.log('/Users/kih/foo', { type: 'session_start', data: { n: 1 } })
    logger.log('/Users/kih/foo', { type: 'hook_request', data: { n: 2 } })
    logger.log('/Users/kih/foo', { type: 'hook_response', data: { n: 3 } })
    await flushMicrotasks()

    const wsDir = join(tmpLogDir, '-Users-kih-foo')
    const files = readdirSync(wsDir)
    const content = readFileSync(join(wsDir, files[0]!), 'utf-8')
    const lines = content.trim().split('\n').filter(Boolean)
    expect(lines).toHaveLength(3)
    // fire-and-forget: appendFile calls are concurrent so ordering is not guaranteed
    const types = new Set(lines.map((l) => JSON.parse(l).type as string))
    expect(types).toEqual(new Set(['session_start', 'hook_request', 'hook_response']))
  })

  it('does nothing when NODE_ENV is production', async () => {
    process.env['NODE_ENV'] = 'production'
    const logger = new WorkspaceLogger()
    // Use a unique path not used by any other test to avoid cross-test race conditions
    logger.log('/production-only-unique-path', { type: 'session_start', data: {} })
    await flushMicrotasks()

    let exists = false
    try {
      readdirSync(join(tmpLogDir, '-production-only-unique-path'))
      exists = true
    } catch {
      exists = false
    }
    expect(exists).toBe(false)
  })
})
