/**
 * Session restore merge 단위 테스트
 *
 * 검증 대상: CC 히스토리 파일(JSONL) 파싱과 DB SessionRow 구조체를 조합할 때의
 * 순서·중복 처리 동작.
 *
 * 현재 코드에는 두 소스를 하나로 합치는 독립 merge 함수가 없으므로,
 * parseSessionHistory(JSONL 소스)를 실제 파일 fixture로 호출하고,
 * DB 소스는 SessionRow 인라인 fixture로 표현한다.
 * 두 결과를 합치는 merge helper는 테스트 내부에서 정의한다.
 *
 * 이 테스트들은 향후 두 소스를 통합하는 서비스 함수 도입 시 그 함수로 이전될 수 있다.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseSessionHistory } from '../../adapters/cli/history-parser.js'
import type { HistoryMessage } from '../../adapters/cli/history-parser.js'
import type { SessionRow } from '../../adapters/db/session-store.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  const dir = join(tmpdir(), `nexus-restore-test-${process.pid}-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

function writeJsonl(filePath: string, lines: unknown[]): void {
  writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8')
}

/**
 * 두 소스를 timestamp 기준 오름차순으로 병합한다.
 * JSONL: HistoryMessage.timestamp (ISO string)
 * DB: SessionRow.created_at (ISO string)
 */
function mergeByTimestamp(
  jsonlMessages: HistoryMessage[],
  dbRows: SessionRow[],
): Array<{ source: 'jsonl' | 'db'; timestamp: string; id: string }> {
  const jsonlItems = jsonlMessages.map((m) => ({
    source: 'jsonl' as const,
    timestamp: m.timestamp,
    id: m.uuid,
  }))
  const dbItems = dbRows.map((r) => ({
    source: 'db' as const,
    timestamp: r.created_at,
    id: r.id,
  }))
  return [...jsonlItems, ...dbItems].sort((a, b) => a.timestamp.localeCompare(b.timestamp))
}

// ---------------------------------------------------------------------------
// JSONL Fixtures
// ---------------------------------------------------------------------------

function makeUserEntry(uuid: string, timestamp: string, text = 'hello') {
  return {
    parentUuid: null,
    isSidechain: false,
    type: 'user',
    message: { role: 'user', content: text },
    uuid,
    timestamp,
  }
}

function makeAssistantEntry(uuid: string, timestamp: string, parentUuid: string) {
  return {
    parentUuid,
    isSidechain: false,
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'response' }],
    },
    uuid,
    timestamp,
  }
}

// DB SessionRow fixture builder (no real DB needed)
function makeSessionRow(id: string, createdAt: string): SessionRow {
  return {
    id,
    cli_session_id: null,
    workspace_path: '/test/workspace',
    agent_id: `agent-${id}`,
    status: 'stopped',
    model: null,
    permission_mode: null,
    prompt: 'test prompt',
    created_at: createdAt,
    ended_at: null,
    error_message: null,
    exit_code: 0,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Session restore — JSONL 소스만 있을 때', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = makeTempDir()
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('JSONL 파일만 있으면 메시지가 파일 순서(오래된 것 → 새것)대로 반환된다', async () => {
    const file = join(tmpDir, 'session.jsonl')
    writeJsonl(file, [
      makeUserEntry('uuid-1', '2026-04-01T10:00:00.000Z', 'first'),
      makeAssistantEntry('uuid-2', '2026-04-01T10:00:01.000Z', 'uuid-1'),
      makeUserEntry('uuid-3', '2026-04-01T10:00:02.000Z', 'second'),
    ])

    const result = await parseSessionHistory(file)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.value).toHaveLength(3)
    expect(result.value[0]!.uuid).toBe('uuid-1')
    expect(result.value[1]!.uuid).toBe('uuid-2')
    expect(result.value[2]!.uuid).toBe('uuid-3')
  })

  it('JSONL 파일이 없으면 HISTORY_FILE_NOT_FOUND 에러를 반환한다', async () => {
    const result = await parseSessionHistory(join(tmpDir, 'missing.jsonl'))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('HISTORY_FILE_NOT_FOUND')
    }
  })

  it('JSONL 파일이 있을 때 offset/limit 슬라이싱이 순서를 보존한다', async () => {
    const file = join(tmpDir, 'session.jsonl')
    writeJsonl(file, [
      makeUserEntry('uuid-1', '2026-04-01T10:00:00.000Z', 'msg1'),
      makeUserEntry('uuid-2', '2026-04-01T10:00:01.000Z', 'msg2'),
      makeUserEntry('uuid-3', '2026-04-01T10:00:02.000Z', 'msg3'),
      makeUserEntry('uuid-4', '2026-04-01T10:00:03.000Z', 'msg4'),
    ])

    // offset=1, limit=2 → uuid-2, uuid-3만 반환 (순서 역전 없음)
    const result = await parseSessionHistory(file, { offset: 1, limit: 2 })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.value).toHaveLength(2)
    expect(result.value[0]!.uuid).toBe('uuid-2')
    expect(result.value[1]!.uuid).toBe('uuid-3')
  })
})

describe('Session restore — DB 소스만 있을 때 (인라인 fixture)', () => {
  it('DB SessionRow fixture에서 id와 created_at을 올바르게 읽는다', () => {
    const rows = [
      makeSessionRow('session-1', '2026-04-01T09:00:00.000Z'),
      makeSessionRow('session-2', '2026-04-01T11:00:00.000Z'),
    ]

    expect(rows).toHaveLength(2)
    expect(rows[0]!.id).toBe('session-1')
    expect(rows[1]!.id).toBe('session-2')
  })

  it('DB SessionRow 배열이 비어있으면 병합 결과도 JSONL 항목만 있다', () => {
    const jsonlItems = [{ source: 'jsonl' as const, timestamp: '2026-04-01T10:00:00.000Z', id: 'uuid-A' }]
    const dbItems: SessionRow[] = []

    const merged = mergeByTimestamp(
      jsonlItems.map((i) => ({ uuid: i.id, timestamp: i.timestamp, type: 'user', parentUuid: null, isSidechain: false, content: { kind: 'user', text: 'x' } } as HistoryMessage)),
      dbItems,
    )

    expect(merged).toHaveLength(1)
    expect(merged[0]!.source).toBe('jsonl')
  })

  it('JSONL 없이 DB만 있으면 병합 결과에 db 항목만 존재한다', () => {
    const dbRows = [
      makeSessionRow('db-session-1', '2026-04-01T09:00:00.000Z'),
      makeSessionRow('db-session-2', '2026-04-01T10:00:00.000Z'),
    ]

    const merged = mergeByTimestamp([], dbRows)

    expect(merged).toHaveLength(2)
    merged.forEach((item) => expect(item.source).toBe('db'))
  })
})

describe('Session restore — 두 소스 병합', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = makeTempDir()
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('JSONL와 DB 두 소스를 timestamp 기준으로 합치면 전체 항목 수가 보존된다', async () => {
    const file = join(tmpDir, 'session.jsonl')
    writeJsonl(file, [
      makeUserEntry('uuid-jsonl-1', '2026-04-01T10:30:00.000Z', 'jsonl message'),
      makeUserEntry('uuid-jsonl-2', '2026-04-01T11:30:00.000Z', 'another'),
    ])

    const dbRows = [
      makeSessionRow('db-session-old', '2026-04-01T09:00:00.000Z'),
      makeSessionRow('db-session-new', '2026-04-01T12:00:00.000Z'),
    ]

    const jsonlResult = await parseSessionHistory(file)
    expect(jsonlResult.ok).toBe(true)
    if (!jsonlResult.ok) return

    const merged = mergeByTimestamp(jsonlResult.value, dbRows)

    // 총 항목 수 = JSONL 2 + DB 2
    expect(merged).toHaveLength(4)
  })

  it('두 소스 병합 시 timestamp 기준 오름차순이 유지된다', async () => {
    const file = join(tmpDir, 'session.jsonl')
    writeJsonl(file, [
      // JSONL 항목이 두 DB 항목 사이에 있음
      makeUserEntry('uuid-mid', '2026-04-01T10:30:00.000Z', 'middle'),
    ])

    const dbRows = [
      makeSessionRow('db-early', '2026-04-01T09:00:00.000Z'),  // 가장 이름
      makeSessionRow('db-late', '2026-04-01T12:00:00.000Z'),   // 가장 나중
    ]

    const jsonlResult = await parseSessionHistory(file)
    expect(jsonlResult.ok).toBe(true)
    if (!jsonlResult.ok) return

    const merged = mergeByTimestamp(jsonlResult.value, dbRows)

    expect(merged).toHaveLength(3)
    // 순서: db-early → uuid-mid(jsonl) → db-late
    expect(merged[0]!.id).toBe('db-early')
    expect(merged[1]!.id).toBe('uuid-mid')
    expect(merged[2]!.id).toBe('db-late')
  })

  it('JSONL uuid는 중복이 없어야 한다', async () => {
    const file = join(tmpDir, 'session.jsonl')
    writeJsonl(file, [
      makeUserEntry('uuid-A', '2026-04-01T10:00:00.000Z'),
      makeUserEntry('uuid-B', '2026-04-01T10:00:01.000Z'),
      makeAssistantEntry('uuid-C', '2026-04-01T10:00:02.000Z', 'uuid-A'),
    ])

    const jsonlResult = await parseSessionHistory(file)
    expect(jsonlResult.ok).toBe(true)
    if (!jsonlResult.ok) return

    const uuids = jsonlResult.value.map((m) => m.uuid)
    const uniqueUuids = new Set(uuids)
    expect(uniqueUuids.size).toBe(uuids.length)
  })
})
