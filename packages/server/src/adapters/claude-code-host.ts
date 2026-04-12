import type { AgentHost, AgentHostConfig, AgentHostEvent } from '@nexus/shared'
import type { Result } from '@nexus/shared'
import { ok, err, appError } from '@nexus/shared'
import { randomUUID } from 'node:crypto'
import type { ProcessSupervisor } from './cli/process-supervisor.js'
import type { ApprovalBridge } from './hooks/approval-bridge.js'
import type { CliProcess } from './cli/cli-process.js'

/**
 * ClaudeCodeHost — AgentHost 인터페이스의 Claude Code 구현체.
 *
 * 기존 ProcessSupervisor + ApprovalBridge와 병렬로 존재하는 격리 래퍼.
 * 현재 어떤 라우트나 서비스에서도 import되지 않음(UI 미연결 상태).
 * Task 11(tester) 검증 이후 app.ts 와이어링 예정.
 */
export class ClaudeCodeHost implements AgentHost {
  /** nexusSessionId → CliProcess */
  private readonly sessions = new Map<string, CliProcess>()

  constructor(
    private readonly processSupervisor: ProcessSupervisor,
    private readonly approvalBridge: ApprovalBridge,
  ) {}

  async spawn(config: AgentHostConfig): Promise<Result<string>> {
    try {
      const { workingDirectory, model, resumeSessionId, continueSession } = config

      // 1. createGroup — 이미 존재하면 무시하고 getGroup으로 가져옴
      if (!this.processSupervisor.getGroup(workingDirectory)) {
        const groupResult = this.processSupervisor.createGroup(workingDirectory)
        if (!groupResult.ok) {
          return err(groupResult.error)
        }
      }

      // 2. nexusSessionId 생성 — SQLite SoT와 일치하는 내부 ID
      const nexusSessionId = randomUUID()

      // 3. createProcessInGroup → CliProcess 인스턴스
      const processResult = this.processSupervisor.createProcessInGroup(
        workingDirectory,
        nexusSessionId,
      )
      if (!processResult.ok) {
        return err(processResult.error)
      }

      const cliProcess = processResult.value
      cliProcess.nexusSessionId = nexusSessionId

      // 4. cliProcess.start() — 실제 spawn 지점
      const startResult = await cliProcess.start({
        prompt: '',
        cwd: workingDirectory,
        model,
        sessionId: resumeSessionId,
        continueSession,
      })
      if (!startResult.ok) {
        // 실패 시 group에서 process 제거
        this.processSupervisor.getGroup(workingDirectory)?.removeProcess(nexusSessionId)
        return err(startResult.error)
      }

      // 5. init 이벤트 race — Claude CLI가 session_id를 보낼 때까지 대기 (최대 10초)
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, 10_000)
        const unsub = cliProcess.on('init', (_data) => {
          clearTimeout(timeout)
          unsub()
          resolve()
        })
      })

      // 6. sessions 맵에 등록
      this.sessions.set(nexusSessionId, cliProcess)

      return ok(nexusSessionId)
    } catch (e) {
      return err(appError('SPAWN_FAILED', 'Failed to spawn ClaudeCodeHost session', { cause: e }))
    }
  }

  async *observe(sessionId: string): AsyncIterable<AgentHostEvent> {
    const cliProcess = this.sessions.get(sessionId)
    if (!cliProcess) return

    // EventEmitter → AsyncGenerator 변환
    // 내부 큐로 이벤트를 버퍼링하고 yield
    const queue: AgentHostEvent[] = []
    let resolve: (() => void) | null = null
    let done = false

    function enqueue(event: AgentHostEvent): void {
      queue.push(event)
      resolve?.()
      resolve = null
    }

    // session_started 즉시 emit
    enqueue({ type: 'session_started', sessionId, harnessType: 'claude-code' })

    const unsubs: Array<() => void> = []

    // init: session_started는 이미 enqueue했으므로 추가 처리 불필요

    // text_chunk / text_delta → message
    unsubs.push(
      cliProcess.on('text_chunk', (data) => {
        enqueue({ type: 'message', sessionId, role: 'assistant', content: data.text })
      }),
    )
    unsubs.push(
      cliProcess.on('text_delta', (data) => {
        enqueue({ type: 'message', sessionId, role: 'assistant', content: data.text })
      }),
    )

    // tool_call → tool_call
    unsubs.push(
      cliProcess.on('tool_call', (data) => {
        enqueue({
          type: 'tool_call',
          sessionId,
          toolName: data.toolName,
          input: data.toolInput,
        })
      }),
    )

    // tool_result → tool_result
    unsubs.push(
      cliProcess.on('tool_result', (data) => {
        enqueue({
          type: 'tool_result',
          sessionId,
          toolUseId: data.toolCallId,
          result: data.result,
        })
      }),
    )

    // permission_request → permission_asked
    unsubs.push(
      cliProcess.on('permission_request', (data) => {
        enqueue({
          type: 'permission_asked',
          sessionId,
          permissionId: data.permissionId,
          toolName: data.toolName,
          input: data.toolInput,
        })
      }),
    )

    // error → error
    unsubs.push(
      cliProcess.on('error', (data) => {
        enqueue({
          type: 'error',
          sessionId,
          code: 'CLI_ERROR',
          message: data.message,
          recoverable: false,
        })
      }),
    )

    // rate_limit → error (recoverable)
    unsubs.push(
      cliProcess.on('rate_limit', (data) => {
        enqueue({
          type: 'error',
          sessionId,
          code: 'RATE_LIMIT',
          message: data.message,
          recoverable: true,
        })
      }),
    )

    // turn_end / status_change(stopped) → session_ended
    unsubs.push(
      cliProcess.on('turn_end', (_data) => {
        enqueue({ type: 'session_ended', sessionId, exitCode: 0 })
        done = true
        resolve?.()
        resolve = null
      }),
    )

    unsubs.push(
      cliProcess.on('status_change', (data) => {
        if (data.status === 'stopped' || data.status === 'error') {
          const exitCode = data.status === 'error' ? 1 : 0
          enqueue({ type: 'session_ended', sessionId, exitCode })
          done = true
          resolve?.()
          resolve = null
        }
      }),
    )

    try {
      while (!done || queue.length > 0) {
        if (queue.length > 0) {
          yield queue.shift()!
        } else {
          await new Promise<void>((r) => { resolve = r })
        }
      }
    } finally {
      for (const unsub of unsubs) unsub()
    }
  }

  async approve(permissionId: string, decision: { allow: boolean }): Promise<Result<void>> {
    try {
      this.approvalBridge.respond(permissionId, decision.allow ? 'allow' : 'deny')
      return ok(undefined)
    } catch (e) {
      return err(appError('APPROVE_FAILED', 'Failed to approve permission', { cause: e }))
    }
  }

  async reject(permissionId: string, reason: string): Promise<Result<void>> {
    try {
      this.approvalBridge.respond(permissionId, 'deny')
      return ok(undefined)
    } catch (e) {
      return err(
        appError('REJECT_FAILED', `Failed to reject permission: ${reason}`, { cause: e }),
      )
    }
  }

  async dispose(sessionId: string): Promise<Result<void>> {
    try {
      const cliProcess = this.sessions.get(sessionId)
      if (!cliProcess) {
        return err(appError('SESSION_NOT_FOUND', `Session '${sessionId}' not found`))
      }

      await cliProcess.cancel()
      cliProcess.dispose()

      const workingDirectory = cliProcess.nexusSessionId
        ? this._findWorkingDirectory(sessionId)
        : null

      this.sessions.delete(sessionId)

      if (workingDirectory) {
        this.processSupervisor.getGroup(workingDirectory)?.removeProcess(sessionId)
      }

      return ok(undefined)
    } catch (e) {
      return err(appError('DISPOSE_FAILED', 'Failed to dispose session', { cause: e }))
    }
  }

  /**
   * ProcessSupervisor의 그룹을 순회하여 sessionId에 해당하는 workingDirectory를 찾는다.
   * dispose 시점에만 호출되므로 성능 비용은 무시 가능.
   */
  private _findWorkingDirectory(sessionId: string): string | null {
    for (const group of this.processSupervisor.listGroups()) {
      if (group.getProcess(sessionId)) {
        return group.workspacePath
      }
    }
    return null
  }
}
