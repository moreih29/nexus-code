import { EventEmitter } from 'events'
import { spawn, ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { execSync } from 'child_process'
import { StreamParser } from './stream-parser'
import { logger, closeSessionStream } from '../logger'
import { startSession, appendLine, endSession as endRawSession } from './cli-raw-logger'
import type {
  TextChunkEvent,
  ToolCallEvent,
  ToolResultEvent,
  PermissionRequestEvent,
  SessionEndEvent,
  TurnEndEvent,
  ErrorEvent,
  SessionStatus,
  RestartAttemptEvent,
  RestartFailedEvent,
  TimeoutEvent,
  RateLimitEvent,
  ImageAttachment,
  PermissionMode,
} from '../../shared/types'

/** 마지막 stdout 출력으로부터 이 시간(ms)이 지나면 timeout 이벤트를 emit */
const ACTIVITY_TIMEOUT_MS = 120_000
/** idle 상태로 이 시간(ms)이 지나면 CLI 프로세스를 자동 종료 (suspended) */
const LONG_IDLE_TIMEOUT_MS = 30 * 60 * 1000

// Claude CLI 바이너리 탐색 경로 목록
const CLAUDE_CANDIDATE_PATHS = [
  '/usr/local/bin/claude',
  '/opt/homebrew/bin/claude',
]

function findClaudeBinary(): string {
  // 고정 경로 탐색
  for (const p of CLAUDE_CANDIDATE_PATHS) {
    if (existsSync(p)) {
      logger.cli.info('claude binary found', { path: p })
      return p
    }
  }

  // npm global bin 경로 탐색
  try {
    const npmPrefix = execSync('npm config get prefix', { encoding: 'utf8', timeout: 3000 }).trim()
    const npmBin = join(npmPrefix, 'bin', 'claude')
    if (existsSync(npmBin)) {
      logger.cli.info('claude binary found', { path: npmBin })
      return npmBin
    }
  } catch {
    // npm 명령이 없거나 실패하면 무시
  }

  // 최종 폴백: PATH에서 찾도록 셸에 위임
  logger.cli.error('claude binary not found', { searchedPaths: [...CLAUDE_CANDIDATE_PATHS] })
  return 'claude'
}

export interface RunOptions {
  prompt: string
  cwd: string
  permissionMode: PermissionMode
  sessionId?: string // --resume 용
  model?: string
  effortLevel?: string
  images?: ImageAttachment[]
}

export declare interface RunManager {
  on(event: 'text_chunk', listener: (data: TextChunkEvent) => void): this
  on(event: 'tool_call', listener: (data: ToolCallEvent) => void): this
  on(event: 'tool_result', listener: (data: ToolResultEvent) => void): this
  on(event: 'permission_request', listener: (data: PermissionRequestEvent) => void): this
  on(event: 'session_end', listener: (data: SessionEndEvent) => void): this
  on(event: 'turn_end', listener: (data: TurnEndEvent) => void): this
  on(event: 'error', listener: (data: ErrorEvent) => void): this
  on(event: 'status_change', listener: (status: SessionStatus) => void): this
  on(event: 'restart_attempt', listener: (data: RestartAttemptEvent) => void): this
  on(event: 'restart_failed', listener: (data: RestartFailedEvent) => void): this
  on(event: 'timeout', listener: (data: TimeoutEvent) => void): this
  on(event: 'rate_limit', listener: (data: RateLimitEvent) => void): this
}

const MAX_RESTART_ATTEMPTS = 3
const RESTART_BACKOFF_MS = [1000, 2000, 4000]

// 재시작 대상 exit code
function shouldRestart(exitCode: number): boolean {
  if (exitCode === 0) return false   // 정상 종료
  if (exitCode === 130) return false  // SIGINT (사용자 취소)
  return true                         // 1, 129(orphan), 기타 에러
}

export class RunManager extends EventEmitter {
  private proc: ChildProcess | null = null
  private parser: StreamParser | null = null
  private sessionId: string = ''
  private status: SessionStatus = 'idle'
  private killTimer: ReturnType<typeof setTimeout> | null = null
  private restartCount: number = 0
  private lastOptions: RunOptions | null = null
  private cancelled: boolean = false
  private activityTimer: ReturnType<typeof setTimeout> | null = null
  private rateLimited: boolean = false
  private longIdleTimer: ReturnType<typeof setTimeout> | null = null

  getSessionId(): string {
    return this.sessionId
  }

  getStatus(): SessionStatus {
    return this.status
  }

  async start(options: RunOptions): Promise<string> {
    if (this.proc && !this.proc.killed) {
      throw new Error(`세션이 이미 실행 중입니다 (${this.sessionId})`)
    }

    this.lastOptions = options
    this.cancelled = false

    const binary = findClaudeBinary()
    const args = this.buildArgs(options)

    logger.cli.info('spawn', { binary, args: args.join(' ') })
    logger.cli.info('cwd', { cwd: options.cwd })

    this.parser = new StreamParser(this.sessionId)
    this.bindParserEvents(options.sessionId)

    this.proc = spawn(binary, args, {
      cwd: options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    })

    logger.cli.info('spawned', { pid: this.proc.pid })

    this.setStatus('running')
    this.resetActivityTimer()
    this.bindProcessEvents()

    // stream-json 입력 모드: 프롬프트를 먼저 보내야 CLI가 init을 반환함
    if (options.prompt) {
      this.sendPrompt(options.prompt, options.images)
    }

    if (!options.sessionId) {
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          logger.cli.warn('session_id 대기 타임아웃 (15s)')
          resolve()
        }, 15_000)

        const onSessionId = (): void => {
          clearTimeout(timeout)
          resolve()
        }
        this.once('_session_id_ready', onSessionId)
      })
    }

    startSession(this.sessionId)

    return this.sessionId
  }

  sendPrompt(message: string, images?: ImageAttachment[]): boolean {
    if (!this.proc || !this.proc.stdin || this.proc.killed) return false
    try {
      const content: unknown[] = [{ type: 'text', text: message }]
      if (images && images.length > 0) {
        for (const img of images) {
          content.push({
            type: 'image',
            source: { type: 'base64', media_type: img.mediaType, data: img.data },
          })
        }
      }
      const jsonMsg = JSON.stringify({
        type: 'user',
        message: { role: 'user', content },
      })
      this.proc.stdin.write(jsonMsg + '\n')
      this.setStatus('running')
      return true
    } catch {
      return false
    }
  }

  cancel(): boolean {
    if (!this.proc || this.proc.killed) return false

    this.cancelled = true
    this.clearActivityTimer()

    // SIGINT 전송
    this.proc.kill('SIGINT')

    // 5초 후에도 살아있으면 SIGTERM
    this.killTimer = setTimeout(() => {
      if (this.proc && !this.proc.killed) {
        this.proc.kill('SIGTERM')
      }
      this.killTimer = null
    }, 5000)

    return true
  }

  /** cancel() 후 프로세스 종료까지 대기 */
  cancelAndWait(): Promise<void> {
    if (!this.proc || this.proc.killed) {
      return Promise.resolve()
    }

    return new Promise<void>((resolve) => {
      const onClose = (): void => resolve()
      this.proc!.once('close', onClose)
      this.proc!.once('error', onClose)
      this.cancel()
      // 안전망: 8초 후 강제 resolve
      setTimeout(resolve, 8000)
    })
  }

  private buildArgs(options: RunOptions): string[] {
    const args: string[] = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--dangerously-skip-permissions',
    ]

    if (options.model) {
      args.push('--model', options.model)
    }

    if (options.effortLevel) {
      args.push('--effort', options.effortLevel)
    }

    if (options.sessionId) {
      args.push('--resume', options.sessionId)
      this.sessionId = options.sessionId
    }

    // 프롬프트는 stdin으로 전송 (args에 추가하지 않음)

    return args
  }

  private bindParserEvents(existingSessionId?: string): void {
    if (!this.parser) return

    this.parser.on('session_id', (id) => {
      if (!existingSessionId) {
        this.sessionId = id
      }
      this.emit('_session_id_ready')
    })

    this.parser.on('text_chunk', (data) => {
      this.resetActivityTimer()
      this.emit('text_chunk', { sessionId: this.sessionId, ...data } satisfies TextChunkEvent)
    })

    this.parser.on('tool_call', (data) => {
      this.resetActivityTimer()
      this.emit('tool_call', { sessionId: this.sessionId, ...data } satisfies ToolCallEvent)
    })

    this.parser.on('tool_result', (data) => {
      this.resetActivityTimer()
      this.emit('tool_result', { sessionId: this.sessionId, ...data } satisfies ToolResultEvent)
    })

    this.parser.on('rate_limit', (data) => {
      logger.cli.info('rate_limit', { retryAfterMs: data.retryAfterMs })
      this.rateLimited = true
      this.clearActivityTimer()
      this.emit('rate_limit', { sessionId: this.sessionId, ...data } satisfies RateLimitEvent)
    })

    this.parser.on('permission_request', (data) => {
      this.setStatus('waiting_permission')
      this.emit('permission_request', {
        sessionId: this.sessionId,
        ...data,
      } satisfies PermissionRequestEvent)
    })

    this.parser.on('turn_end', (data) => {
      this.restartCount = 0
      this.clearActivityTimer()
      this.emit('turn_end', { sessionId: this.sessionId, ...data } satisfies TurnEndEvent)
      this.setStatus('idle')
    })

    this.parser.on('error', (data) => {
      this.emit('error', { sessionId: this.sessionId, ...data } satisfies ErrorEvent)
    })
  }

  private bindProcessEvents(): void {
    if (!this.proc) return

    this.proc.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      logger.cli.debug('stdout chunk', { len: text.length, sessionId: this.sessionId })
      appendLine(this.sessionId, text)
      // rate limit이 해제된 경우 타이머 재시작
      if (this.rateLimited) {
        this.rateLimited = false
        this.resetActivityTimer()
      }
      this.parser?.feed(text)
    })

    this.proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim()
      if (text) {
        logger.cli.warn('stderr', { text, sessionId: this.sessionId })
      }
    })

    this.proc.on('close', (code: number | null) => {
      this.clearKillTimer()
      this.clearActivityTimer()
      this.parser?.flush()

      const exitCode = code ?? 0

      // suspended 상태로 인한 종료 — 크래시 재시작 없이 상태 유지
      if (this.status === 'suspended') {
        this.cleanup()
        return
      }

      if (!this.cancelled && shouldRestart(exitCode) && this.restartCount < MAX_RESTART_ATTEMPTS) {
        const attempt = this.restartCount + 1
        const reason = `프로세스가 비정상 종료되었습니다 (exit ${exitCode})`

        logger.cli.warn('크래시 감지, 재시작 시도', { exitCode, attempt, maxAttempts: MAX_RESTART_ATTEMPTS, sessionId: this.sessionId })

        this.emit('restart_attempt', {
          sessionId: this.sessionId,
          attempt,
          maxAttempts: MAX_RESTART_ATTEMPTS,
          reason,
        } satisfies RestartAttemptEvent)
        this.setStatus('restarting')
        this.cleanup()

        const delay = RESTART_BACKOFF_MS[this.restartCount] ?? 4000
        this.restartCount = attempt

        setTimeout(() => {
          this.doRestart().catch((err: Error) => {
            logger.cli.error('재시작 실패', { error: String(err), sessionId: this.sessionId })
          })
        }, delay)
        return
      }

      if (!this.cancelled && shouldRestart(exitCode) && this.restartCount >= MAX_RESTART_ATTEMPTS) {
        logger.cli.error('재시작 횟수 초과, 포기', { maxAttempts: MAX_RESTART_ATTEMPTS, exitCode, sessionId: this.sessionId })
        this.emit('restart_failed', {
          sessionId: this.sessionId,
          reason: `${MAX_RESTART_ATTEMPTS}회 재시작 후에도 계속 실패 (exit ${exitCode})`,
        } satisfies RestartFailedEvent)
        this.setStatus('error')
        this.cleanup()
        closeSessionStream(this.sessionId)
        endRawSession(this.sessionId)
        return
      }

      closeSessionStream(this.sessionId)
      endRawSession(this.sessionId)
      this.emit('session_end', {
        sessionId: this.sessionId,
        exitCode,
      } satisfies SessionEndEvent)
      this.setStatus('ended')
      this.cleanup()
    })

    this.proc.on('error', (err: Error) => {
      this.clearKillTimer()
      closeSessionStream(this.sessionId)
      endRawSession(this.sessionId)
      this.emit('error', {
        sessionId: this.sessionId,
        message: err.message,
        code: (err as NodeJS.ErrnoException).code,
      } satisfies ErrorEvent)
      this.setStatus('error')
      this.cleanup()
    })
  }

  private async doRestart(): Promise<void> {
    if (!this.lastOptions) {
      this.emit('restart_failed', {
        sessionId: this.sessionId,
        reason: '재시작 옵션 없음',
      } satisfies RestartFailedEvent)
      this.setStatus('error')
      return
    }

    const restartOptions: RunOptions = {
      ...this.lastOptions,
      prompt: '',
      sessionId: this.sessionId || this.lastOptions.sessionId,
    }

    const binary = findClaudeBinary()
    const args = this.buildArgs(restartOptions)

    logger.cli.info('재시작 spawn', { binary, args: args.join(' '), sessionId: this.sessionId })

    this.parser = new StreamParser(this.sessionId)
    this.bindParserEvents(restartOptions.sessionId)

    this.proc = spawn(binary, args, {
      cwd: restartOptions.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    })

    logger.cli.info('재시작 spawned', { pid: this.proc.pid, sessionId: this.sessionId })

    this.setStatus('running')
    this.resetActivityTimer()
    this.bindProcessEvents()

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.restartCount >= MAX_RESTART_ATTEMPTS) {
          this.emit('restart_failed', {
            sessionId: this.sessionId,
            reason: `${MAX_RESTART_ATTEMPTS}회 재시작 후 세션 준비 실패`,
          } satisfies RestartFailedEvent)
          this.setStatus('error')
        }
        resolve()
      }, 15_000)

      const onReady = (): void => {
        clearTimeout(timeout)
        resolve()
      }
      const onError = (err: Error): void => {
        clearTimeout(timeout)
        reject(err)
      }
      this.once('_session_id_ready', onReady)
      this.once('error', onError)
    })
  }

  private setStatus(status: SessionStatus): void {
    if (this.status !== status) {
      this.status = status
      this.emit('status_change', status)

      if (status === 'idle') {
        // idle 진입 → 30분 타이머 시작
        this.resetLongIdleTimer()
      } else if (status === 'running' || status === 'waiting_permission') {
        // 활성 상태 → 타이머 취소
        this.clearLongIdleTimer()
      }
    }
  }

  private resetLongIdleTimer(): void {
    this.clearLongIdleTimer()
    this.longIdleTimer = setTimeout(() => {
      this.longIdleTimer = null
      if (this.status !== 'idle') return
      logger.cli.info('long idle timeout — suspending session', { timeoutMs: LONG_IDLE_TIMEOUT_MS, sessionId: this.sessionId })
      this.suspend()
    }, LONG_IDLE_TIMEOUT_MS)
  }

  private clearLongIdleTimer(): void {
    if (this.longIdleTimer !== null) {
      clearTimeout(this.longIdleTimer)
      this.longIdleTimer = null
    }
  }

  /** 30분 idle로 인한 자동 프로세스 종료 */
  private suspend(): void {
    if (!this.proc || this.proc.killed) {
      // 프로세스가 없어도 상태는 suspended로 전환
      this.setStatus('suspended')
      return
    }
    // suspended 상태로 전환 후 프로세스 종료
    this.status = 'suspended'
    this.emit('status_change', 'suspended' as SessionStatus)
    this.cancelled = true
    this.proc.kill('SIGTERM')
    logger.cli.info('session suspended (long idle)', { sessionId: this.sessionId })
  }

  private clearKillTimer(): void {
    if (this.killTimer !== null) {
      clearTimeout(this.killTimer)
      this.killTimer = null
    }
  }

  private resetActivityTimer(): void {
    this.clearActivityTimer()
    if (this.rateLimited) return  // rate limit 중에는 타이머 시작 안 함
    this.activityTimer = setTimeout(() => {
      this.activityTimer = null
      logger.cli.warn('activity timeout', { timeoutMs: ACTIVITY_TIMEOUT_MS, sessionId: this.sessionId })
      this.setStatus('timeout')
      this.emit('timeout', {
        sessionId: this.sessionId,
        timeoutMs: ACTIVITY_TIMEOUT_MS,
      } satisfies TimeoutEvent)
    }, ACTIVITY_TIMEOUT_MS)
  }

  private clearActivityTimer(): void {
    if (this.activityTimer !== null) {
      clearTimeout(this.activityTimer)
      this.activityTimer = null
    }
  }

  private cleanup(): void {
    this.clearLongIdleTimer()
    this.proc = null
    this.parser = null
  }
}
