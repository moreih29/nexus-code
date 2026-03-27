import { EventEmitter } from 'events'
import { spawn, ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { execSync } from 'child_process'
import { StreamParser } from './stream-parser'
import log from './logger'
import { startSession, appendLine } from './cli-raw-logger'
import type {
  TextChunkEvent,
  ToolCallEvent,
  ToolResultEvent,
  PermissionRequestEvent,
  SessionEndEvent,
  TurnEndEvent,
  ErrorEvent,
  SessionStatus,
} from '../shared/types'

// Claude CLI 바이너리 탐색 경로 목록
const CLAUDE_CANDIDATE_PATHS = [
  '/usr/local/bin/claude',
  '/opt/homebrew/bin/claude',
]

function findClaudeBinary(): string {
  // 고정 경로 탐색
  for (const p of CLAUDE_CANDIDATE_PATHS) {
    if (existsSync(p)) return p
  }

  // npm global bin 경로 탐색
  try {
    const npmPrefix = execSync('npm config get prefix', { encoding: 'utf8', timeout: 3000 }).trim()
    const npmBin = join(npmPrefix, 'bin', 'claude')
    if (existsSync(npmBin)) return npmBin
  } catch {
    // npm 명령이 없거나 실패하면 무시
  }

  // 최종 폴백: PATH에서 찾도록 셸에 위임
  return 'claude'
}

export interface RunOptions {
  prompt: string
  cwd: string
  permissionMode: 'auto' | 'manual'
  sessionId?: string // --resume 용
  hookUrl?: string   // HookServer의 pre-tool-use 훅 URL
  model?: string
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
}

export class RunManager extends EventEmitter {
  private proc: ChildProcess | null = null
  private parser: StreamParser | null = null
  private sessionId: string = ''
  private status: SessionStatus = 'idle'
  private killTimer: ReturnType<typeof setTimeout> | null = null

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

    const binary = findClaudeBinary()
    const args = this.buildArgs(options)

    log.info('[RunManager] spawn:', binary, args.join(' '))
    log.info('[RunManager] cwd:', options.cwd)

    this.parser = new StreamParser()
    this.bindParserEvents(options.sessionId)

    this.proc = spawn(binary, args, {
      cwd: options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    })

    log.info('[RunManager] pid:', this.proc.pid)

    this.setStatus('running')
    this.bindProcessEvents()

    // stream-json 입력 모드: 프롬프트를 먼저 보내야 CLI가 init을 반환함
    if (options.prompt) {
      this.sendPrompt(options.prompt)
    }

    if (!options.sessionId) {
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          log.warn('[RunManager] session_id 대기 타임아웃 (15s)')
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

  sendPrompt(message: string): boolean {
    if (!this.proc || !this.proc.stdin || this.proc.killed) return false
    try {
      const jsonMsg = JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: message }] },
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

  private buildArgs(options: RunOptions): string[] {
    const args: string[] = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
    ]

    if (options.permissionMode === 'auto') {
      args.push('--dangerously-skip-permissions')
    } else if (options.hookUrl) {
      // HookServer 경유 퍼미션 처리
      args.push('--permission-prompt-tool', `Bash(curl -s -X POST '${options.hookUrl}' -H 'Content-Type: application/json' -d @-)`)
    }

    if (options.model) {
      args.push('--model', options.model)
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
      this.emit('text_chunk', { sessionId: this.sessionId, ...data } satisfies TextChunkEvent)
    })

    this.parser.on('tool_call', (data) => {
      this.emit('tool_call', { sessionId: this.sessionId, ...data } satisfies ToolCallEvent)
    })

    this.parser.on('tool_result', (data) => {
      this.emit('tool_result', { sessionId: this.sessionId, ...data } satisfies ToolResultEvent)
    })

    this.parser.on('permission_request', (data) => {
      this.setStatus('waiting_permission')
      this.emit('permission_request', {
        sessionId: this.sessionId,
        ...data,
      } satisfies PermissionRequestEvent)
    })

    this.parser.on('turn_end', (data) => {
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
      appendLine(chunk.toString('utf8'))
      this.parser?.feed(chunk.toString('utf8'))
    })

    this.proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim()
      if (text) {
        log.warn('[claude stderr]', text)
      }
    })

    this.proc.on('close', (code: number | null) => {
      this.clearKillTimer()
      this.parser?.flush()

      const exitCode = code ?? 0
      this.emit('session_end', {
        sessionId: this.sessionId,
        exitCode,
      } satisfies SessionEndEvent)
      this.setStatus('ended')
      this.cleanup()
    })

    this.proc.on('error', (err: Error) => {
      this.clearKillTimer()
      this.emit('error', {
        sessionId: this.sessionId,
        message: err.message,
        code: (err as NodeJS.ErrnoException).code,
      } satisfies ErrorEvent)
      this.setStatus('error')
      this.cleanup()
    })
  }

  private setStatus(status: SessionStatus): void {
    if (this.status !== status) {
      this.status = status
      this.emit('status_change', status)
    }
  }

  private clearKillTimer(): void {
    if (this.killTimer !== null) {
      clearTimeout(this.killTimer)
      this.killTimer = null
    }
  }

  private cleanup(): void {
    this.proc = null
    this.parser = null
  }
}
