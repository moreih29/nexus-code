import { z } from 'zod'
import type { Result } from '../result.js'

/**
 * AgentHost — 하네스별 구현체의 공통 계약.
 *
 * Claude Code adapter(packages/server/src/adapters/claude-code-host.ts)와
 * OpenCode adapter(packages/server/src/adapters/opencode-host.ts)가 이 인터페이스를 구현한다.
 *
 * ## sessionId 의미론
 *
 * 이 인터페이스의 sessionId는 **nexus 내부 세션 ID**(nexusSessionId)를 의미한다.
 * Claude CLI가 부여하는 외부 sessionId(cli-process.ts의 `_sessionId`)와는 별개의 체계다.
 *
 * - `spawn()`은 nexusSessionId를 반환한다 — 이 값은 SQLite SoT 및 UI와 일치한다.
 * - `resumeSessionId` 옵션은 Claude CLI 외부 sessionId를 받아 `--resume` 플래그로 전달한다.
 * - `observe/approve/reject/dispose`의 첫 인자는 모두 nexusSessionId다.
 */

export const HarnessTypeSchema = z.enum(['claude-code', 'opencode'])
export type HarnessType = z.infer<typeof HarnessTypeSchema>

// ---------------------------------------------------------------------------
// AgentHostEvent — Zod 스키마 (runtime-export)
// ---------------------------------------------------------------------------

export const SessionStartedEventSchema = z.object({
  type: z.literal('session_started'),
  sessionId: z.string(),
  harnessType: HarnessTypeSchema,
})

export const MessageEventSchema = z.object({
  type: z.literal('message'),
  sessionId: z.string(),
  role: z.enum(['assistant', 'user']),
  content: z.string(),
})

// Prefixed to avoid collision with ToolCallEventSchema in schemas/session.ts
export const AgentHostToolCallEventSchema = z.object({
  type: z.literal('tool_call'),
  sessionId: z.string(),
  toolName: z.string(),
  input: z.union([z.record(z.string(), z.unknown()), z.string()]),
})

// Prefixed to avoid collision with ToolResultEventSchema in schemas/session.ts
export const AgentHostToolResultEventSchema = z.object({
  type: z.literal('tool_result'),
  sessionId: z.string(),
  toolUseId: z.string(),
  result: z.unknown(),
})

export const PermissionAskedEventSchema = z.object({
  type: z.literal('permission_asked'),
  sessionId: z.string(),
  permissionId: z.string(),
  toolName: z.string(),
  input: z.union([z.record(z.string(), z.unknown()), z.string()]),
  harnessType: HarnessTypeSchema,
  workingDirectory: z.string(),
})

export const ErrorEventSchema = z.object({
  type: z.literal('error'),
  sessionId: z.string(),
  code: z.string(),
  message: z.string(),
  recoverable: z.boolean(),
})

export const SessionEndedEventSchema = z.object({
  type: z.literal('session_ended'),
  sessionId: z.string(),
  exitCode: z.number().nullable(),
})

export const AgentHostEventSchema = z.discriminatedUnion('type', [
  SessionStartedEventSchema,
  MessageEventSchema,
  AgentHostToolCallEventSchema,
  AgentHostToolResultEventSchema,
  PermissionAskedEventSchema,
  ErrorEventSchema,
  SessionEndedEventSchema,
])

export type AgentHostEvent = z.infer<typeof AgentHostEventSchema>

// ---------------------------------------------------------------------------
// AgentHostConfig — base + per-harness extensions
// ---------------------------------------------------------------------------

export const AgentHostConfigSchema = z.object({
  harnessType: HarnessTypeSchema,
  workingDirectory: z.string(),
  model: z.string().optional(),
  /** Claude CLI 외부 sessionId를 받아 `--resume` 플래그로 전달한다. nexusSessionId와 구분할 것. */
  resumeSessionId: z.string().optional(),
  /** 마지막 세션에 이어 붙인다(--continue). resumeSessionId와 함께 사용할 수 없다. */
  continueSession: z.boolean().optional(),
})

export type AgentHostConfig = z.infer<typeof AgentHostConfigSchema>

export const ClaudeCodeHostConfigSchema = AgentHostConfigSchema.extend({
  harnessType: z.literal('claude-code'),
  /** Claude CLI 전용 추가 플래그. 다른 어댑터에서는 사용 불가. */
  extraArgs: z.array(z.string()).readonly().optional(),
})

export type ClaudeCodeHostConfig = z.infer<typeof ClaudeCodeHostConfigSchema>

// ---------------------------------------------------------------------------
// AgentHost interface
// ---------------------------------------------------------------------------

export interface AgentHost {
  /**
   * 새 하네스 세션을 외부 프로세스로 시작한다.
   * @returns nexusSessionId(내부 ID). Result.ok로 감싸 반환.
   */
  spawn(config: AgentHostConfig): Promise<Result<string>>

  /**
   * 세션 이벤트 스트림을 구독한다 (read-only).
   * 첫 인자는 nexusSessionId.
   */
  observe(sessionId: string): AsyncIterable<AgentHostEvent>

  /** 권한 요청을 승인한다. */
  approve(permissionId: string, decision: { allow: boolean }): Promise<Result<void>>

  /** 권한 요청을 거부한다. */
  reject(permissionId: string, reason: string): Promise<Result<void>>

  /** 세션을 종료하고 리소스를 해제한다. 첫 인자는 nexusSessionId. */
  dispose(sessionId: string): Promise<Result<void>>
}
