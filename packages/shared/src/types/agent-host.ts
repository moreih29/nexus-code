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

export type AgentHostEvent =
  | { type: 'session_started'; sessionId: string; harnessType: 'claude-code' | 'opencode' }
  | { type: 'message'; sessionId: string; role: 'assistant' | 'user'; content: string }
  | { type: 'tool_call'; sessionId: string; toolName: string; input: Record<string, unknown> | string }
  | { type: 'tool_result'; sessionId: string; toolUseId: string; result: unknown }
  | {
      type: 'permission_asked'
      sessionId: string
      permissionId: string
      toolName: string
      input: Record<string, unknown> | string
    }
  | { type: 'error'; sessionId: string; code: string; message: string; recoverable: boolean }
  | { type: 'session_ended'; sessionId: string; exitCode: number | null }

export interface AgentHostConfig {
  harnessType: 'claude-code' | 'opencode'
  workingDirectory: string
  model?: string
  /** Claude CLI 외부 sessionId를 받아 `--resume` 플래그로 전달한다. nexusSessionId와 구분할 것. */
  resumeSessionId?: string
  /** 마지막 세션에 이어 붙인다(--continue). resumeSessionId와 함께 사용할 수 없다. */
  continueSession?: boolean
  /** 하네스별 추가 플래그. 각 어댑터가 해석한다. */
  extraArgs?: readonly string[]
}

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
