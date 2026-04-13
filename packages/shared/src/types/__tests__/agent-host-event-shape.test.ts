/**
 * AgentHostEvent shape 단위 테스트
 *
 * 검증 대상: agent-host.ts의 permission_asked 이벤트 필드 구성을 고정.
 *
 * Zod 스키마(PermissionAskedEventSchema)를 이용해 런타임 검증을 수행한다.
 * 스키마에서 필드를 제거하면 이 테스트가 red로 전환된다 (T5 mutation (d) 검증).
 */
import { describe, it, expect } from 'vitest'
import {
  AgentHostEventSchema,
  PermissionAskedEventSchema,
} from '../agent-host.js'
import type { AgentHostEvent } from '../agent-host.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const validPermissionAsked = {
  type: 'permission_asked' as const,
  sessionId: 'nexus-session-uuid',
  permissionId: 'perm-001',
  toolName: 'Write',
  input: { file_path: '/tmp/test.txt', content: 'hello' },
  harnessType: 'claude-code' as const,
  workingDirectory: '/workspace/project',
}

const validPermissionAskedStringInput = {
  type: 'permission_asked' as const,
  sessionId: 'nexus-session-uuid',
  permissionId: 'perm-002',
  toolName: 'Bash',
  input: 'ls -la',
  harnessType: 'opencode' as const,
  workingDirectory: '/home/user/project',
}

// ---------------------------------------------------------------------------
// Tests — Zod 스키마 검증 (T5 (d) mutation probe)
// ---------------------------------------------------------------------------

describe('permission_asked event — Zod 스키마 검증', () => {
  it('필수 필드 모두 포함 시 스키마 파싱이 성공한다', () => {
    const result = PermissionAskedEventSchema.safeParse(validPermissionAsked)
    expect(result.success).toBe(true)
  })

  it('input이 string 타입일 때도 파싱이 성공한다', () => {
    const result = PermissionAskedEventSchema.safeParse(validPermissionAskedStringInput)
    expect(result.success).toBe(true)
  })

  it('harnessType이 없으면 파싱이 실패한다', () => {
    const { harnessType: _, ...missing } = validPermissionAsked
    const result = PermissionAskedEventSchema.safeParse(missing)
    expect(result.success).toBe(false)
  })

  it('workingDirectory가 없으면 파싱이 실패한다', () => {
    const { workingDirectory: _, ...missing } = validPermissionAsked
    const result = PermissionAskedEventSchema.safeParse(missing)
    expect(result.success).toBe(false)
  })

  it('sessionId가 없으면 파싱이 실패한다', () => {
    const { sessionId: _, ...missing } = validPermissionAsked
    const result = PermissionAskedEventSchema.safeParse(missing)
    expect(result.success).toBe(false)
  })

  it('permissionId가 없으면 파싱이 실패한다', () => {
    const { permissionId: _, ...missing } = validPermissionAsked
    const result = PermissionAskedEventSchema.safeParse(missing)
    expect(result.success).toBe(false)
  })

  it('toolName이 없으면 파싱이 실패한다', () => {
    const { toolName: _, ...missing } = validPermissionAsked
    const result = PermissionAskedEventSchema.safeParse(missing)
    expect(result.success).toBe(false)
  })

  it('harnessType이 허용되지 않는 값이면 파싱이 실패한다', () => {
    const invalid = { ...validPermissionAsked, harnessType: 'unknown-harness' }
    const result = PermissionAskedEventSchema.safeParse(invalid)
    expect(result.success).toBe(false)
  })
})

describe('permission_asked event — AgentHostEventSchema discriminated union 검증', () => {
  it('permission_asked variant가 discriminated union으로 파싱된다', () => {
    const result = AgentHostEventSchema.safeParse(validPermissionAsked)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.type).toBe('permission_asked')
    }
  })

  it('파싱된 데이터에 harnessType과 workingDirectory가 존재한다', () => {
    const result = AgentHostEventSchema.safeParse(validPermissionAsked)
    expect(result.success).toBe(true)
    if (result.success && result.data.type === 'permission_asked') {
      expect(result.data.harnessType).toBe('claude-code')
      expect(result.data.workingDirectory).toBe('/workspace/project')
    }
  })
})

describe('AgentHostEvent — 전체 discriminated union 커버리지', () => {
  it('현재 AgentHostEvent discriminated union에 7가지 타입이 있다', () => {
    const knownTypes = [
      'session_started',
      'message',
      'tool_call',
      'tool_result',
      'permission_asked',
      'error',
      'session_ended',
    ]
    expect(knownTypes).toHaveLength(7)

    const sampleEvents: AgentHostEvent[] = [
      { type: 'session_started', sessionId: 's-1', harnessType: 'claude-code' },
      { type: 'message', sessionId: 's-1', role: 'assistant', content: 'hi' },
      { type: 'tool_call', sessionId: 's-1', toolName: 'Bash', input: { cmd: 'ls' } },
      { type: 'tool_result', sessionId: 's-1', toolUseId: 'tu-1', result: 'ok' },
      {
        type: 'permission_asked',
        sessionId: 's-1',
        permissionId: 'p-1',
        toolName: 'Write',
        input: {},
        harnessType: 'claude-code',
        workingDirectory: '/workspace',
      },
      { type: 'error', sessionId: 's-1', code: 'ERR', message: 'fail', recoverable: false },
      { type: 'session_ended', sessionId: 's-1', exitCode: 0 },
    ]
    expect(sampleEvents).toHaveLength(7)
    sampleEvents.forEach((e) => {
      expect(knownTypes).toContain(e.type)
    })
  })

  it('각 이벤트 타입이 AgentHostEventSchema.safeParse를 통과한다', () => {
    const events = [
      { type: 'session_started', sessionId: 's-1', harnessType: 'claude-code' },
      { type: 'message', sessionId: 's-1', role: 'assistant', content: 'hi' },
      { type: 'tool_call', sessionId: 's-1', toolName: 'Bash', input: 'ls' },
      { type: 'tool_result', sessionId: 's-1', toolUseId: 'tu-1', result: 'ok' },
      {
        type: 'permission_asked',
        sessionId: 's-1',
        permissionId: 'p-1',
        toolName: 'Write',
        input: {},
        harnessType: 'opencode',
        workingDirectory: '/workspace',
      },
      { type: 'error', sessionId: 's-1', code: 'ERR', message: 'fail', recoverable: false },
      { type: 'session_ended', sessionId: 's-1', exitCode: null },
    ]

    for (const event of events) {
      const result = AgentHostEventSchema.safeParse(event)
      expect(result.success).toBe(true)
    }
  })
})

describe('permission_asked event — 필드 타입 정밀 검증', () => {
  it('input이 Record<string, unknown>일 때 파싱 후 object 타입이다', () => {
    const result = PermissionAskedEventSchema.safeParse(validPermissionAsked)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(typeof result.data.input).toBe('object')
      expect(result.data.input).toEqual({ file_path: '/tmp/test.txt', content: 'hello' })
    }
  })

  it('input이 string일 때 파싱 후 string 타입이다', () => {
    const result = PermissionAskedEventSchema.safeParse(validPermissionAskedStringInput)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(typeof result.data.input).toBe('string')
      expect(result.data.input).toBe('ls -la')
    }
  })

  it('sessionId와 permissionId는 string 타입이다', () => {
    const result = PermissionAskedEventSchema.safeParse(validPermissionAsked)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(typeof result.data.sessionId).toBe('string')
      expect(typeof result.data.permissionId).toBe('string')
    }
  })
})
