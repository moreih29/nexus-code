import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getSessionFilePath, parseSessionHistory } from '../history-parser.js'

// ---- helpers ----

function makeTempDir(): string {
  const dir = join(tmpdir(), `nexus-test-${process.pid}-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

function writeJsonl(filePath: string, lines: unknown[]): void {
  writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8')
}

// ---- sample JSONL entries ----

const userEntry = {
  parentUuid: null,
  isSidechain: false,
  type: 'user',
  message: { role: 'user', content: '안녕하세요' },
  uuid: 'uuid-user-1',
  timestamp: '2026-04-07T10:00:00.000Z',
}

const assistantEntry = {
  parentUuid: 'uuid-user-1',
  isSidechain: false,
  type: 'assistant',
  message: {
    role: 'assistant',
    content: [
      { type: 'text', text: '안녕하세요!' },
      {
        type: 'tool_use',
        id: 'tool-1',
        name: 'Bash',
        input: { command: 'ls' },
      },
    ],
  },
  uuid: 'uuid-asst-1',
  timestamp: '2026-04-07T10:00:01.000Z',
}

const toolResultEntry = {
  parentUuid: 'uuid-asst-1',
  isSidechain: false,
  type: 'tool_result',
  tool_use_id: 'tool-1',
  content: 'file1.ts\nfile2.ts',
  uuid: 'uuid-tool-1',
  timestamp: '2026-04-07T10:00:02.000Z',
}

const progressEntry = {
  parentUuid: null,
  isSidechain: false,
  type: 'progress',
  data: { some: 'data' },
  parentToolUseID: 'tool-1',
}

const snapshotEntry = {
  type: 'file-history-snapshot',
  messageId: 'msg-1',
  snapshot: { files: [] },
}

// ---- tests ----

describe('getSessionFilePath', () => {
  it('encodes workspace path slashes as dashes', () => {
    const home = process.env['HOME'] ?? '~'
    const result = getSessionFilePath('/Users/kih/workspaces', 'session-123')
    expect(result).toBe(`${home}/.claude/projects/-Users-kih-workspaces/session-123.jsonl`)
  })

  it('handles path with trailing slash', () => {
    const home = process.env['HOME'] ?? '~'
    const result = getSessionFilePath('/Users/kih/', 'abc')
    expect(result).toBe(`${home}/.claude/projects/-Users-kih-/abc.jsonl`)
  })
})

describe('parseSessionHistory', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = makeTempDir()
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns FILE_NOT_FOUND error for non-existent file', async () => {
    const result = await parseSessionHistory(join(tmpDir, 'nonexistent.jsonl'))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('HISTORY_FILE_NOT_FOUND')
    }
  })

  it('parses user message', async () => {
    const file = join(tmpDir, 'session.jsonl')
    writeJsonl(file, [userEntry])

    const result = await parseSessionHistory(file)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.value).toHaveLength(1)
    const msg = result.value[0]!
    expect(msg.type).toBe('user')
    expect(msg.uuid).toBe('uuid-user-1')
    expect(msg.parentUuid).toBeNull()
    expect(msg.isSidechain).toBe(false)
    expect(msg.content).toMatchObject({ kind: 'user', text: '안녕하세요' })
  })

  it('parses assistant message with text and tool_use blocks', async () => {
    const file = join(tmpDir, 'session.jsonl')
    writeJsonl(file, [assistantEntry])

    const result = await parseSessionHistory(file)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.value).toHaveLength(1)
    const msg = result.value[0]!
    expect(msg.type).toBe('assistant')
    expect(msg.content).toMatchObject({
      kind: 'assistant',
      blocks: [
        { type: 'text', text: '안녕하세요!' },
        { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'ls' } },
      ],
    })
  })

  it('parses tool_result message', async () => {
    const file = join(tmpDir, 'session.jsonl')
    writeJsonl(file, [toolResultEntry])

    const result = await parseSessionHistory(file)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.value).toHaveLength(1)
    const msg = result.value[0]!
    expect(msg.type).toBe('tool_result')
    expect(msg.content).toMatchObject({
      kind: 'tool_result',
      toolUseId: 'tool-1',
      output: 'file1.ts\nfile2.ts',
    })
  })

  it('filters out progress and file-history-snapshot entries', async () => {
    const file = join(tmpDir, 'session.jsonl')
    writeJsonl(file, [progressEntry, snapshotEntry, userEntry])

    const result = await parseSessionHistory(file)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.value).toHaveLength(1)
    expect(result.value[0]!.type).toBe('user')
  })

  it('returns all conversation message types from mixed file', async () => {
    const file = join(tmpDir, 'session.jsonl')
    writeJsonl(file, [progressEntry, userEntry, snapshotEntry, assistantEntry, toolResultEntry])

    const result = await parseSessionHistory(file)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.value).toHaveLength(3)
    expect(result.value.map((m) => m.type)).toEqual(['user', 'assistant', 'tool_result'])
  })

  it('respects limit option', async () => {
    const file = join(tmpDir, 'session.jsonl')
    writeJsonl(file, [userEntry, assistantEntry, toolResultEntry])

    const result = await parseSessionHistory(file, { limit: 2 })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.value).toHaveLength(2)
    expect(result.value[0]!.type).toBe('user')
    expect(result.value[1]!.type).toBe('assistant')
  })

  it('respects offset option', async () => {
    const file = join(tmpDir, 'session.jsonl')
    writeJsonl(file, [userEntry, assistantEntry, toolResultEntry])

    const result = await parseSessionHistory(file, { offset: 1 })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.value).toHaveLength(2)
    expect(result.value[0]!.type).toBe('assistant')
    expect(result.value[1]!.type).toBe('tool_result')
  })

  it('respects offset and limit together', async () => {
    const file = join(tmpDir, 'session.jsonl')
    writeJsonl(file, [userEntry, assistantEntry, toolResultEntry])

    const result = await parseSessionHistory(file, { offset: 1, limit: 1 })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.value).toHaveLength(1)
    expect(result.value[0]!.type).toBe('assistant')
  })

  it('returns empty array when offset exceeds total message count', async () => {
    const file = join(tmpDir, 'session.jsonl')
    writeJsonl(file, [userEntry])

    const result = await parseSessionHistory(file, { offset: 10 })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.value).toHaveLength(0)
  })

  it('skips malformed JSON lines without failing', async () => {
    const file = join(tmpDir, 'session.jsonl')
    writeFileSync(file, `not valid json\n${JSON.stringify(userEntry)}\n`, 'utf8')

    const result = await parseSessionHistory(file)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.value).toHaveLength(1)
  })

  it('handles empty file', async () => {
    const file = join(tmpDir, 'session.jsonl')
    writeFileSync(file, '', 'utf8')

    const result = await parseSessionHistory(file)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.value).toHaveLength(0)
  })
})
