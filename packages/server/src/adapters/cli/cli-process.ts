import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import { ok, err, appError } from '@nexus/shared'
import type { Result } from '@nexus/shared'
import { StreamParser, type StreamParserEvents } from './stream-parser.js'
import { DisposableStore } from './disposable.js'

export type CliProcessStatus =
  | 'idle'
  | 'starting'
  | 'running'
  | 'waiting_permission'
  | 'stopping'
  | 'stopped'
  | 'error'

export interface CliStartOptions {
  prompt: string
  cwd: string
  permissionMode?: 'default' | 'auto' | 'bypassPermissions'
  sessionId?: string
  model?: string
  maxTurns?: number
  continueSession?: boolean
}

type Handler<T> = (data: T) => void

export interface CliProcessEvents extends StreamParserEvents {
  status_change: { status: CliProcessStatus }
}

type CliEventName = keyof CliProcessEvents

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ListenerMap = Map<CliEventName, Set<Handler<any>>>

export class CliProcess {
  private _status: CliProcessStatus = 'idle'
  private _process: ChildProcess | null = null
  private _parser: StreamParser | null = null
  private readonly _store = new DisposableStore()
  private readonly _listeners: ListenerMap = new Map()
  private _cancelTimer: ReturnType<typeof setTimeout> | null = null
  meta: Record<string, unknown> = {}

  on<E extends CliEventName>(event: E, handler: Handler<CliProcessEvents[E]>): () => void {
    if (!this._listeners.has(event)) {
      this._listeners.set(event, new Set())
    }
    this._listeners.get(event)!.add(handler)
    return () => {
      this._listeners.get(event)?.delete(handler)
    }
  }

  getStatus(): CliProcessStatus {
    return this._status
  }

  async start(options: CliStartOptions): Promise<Result<void>> {
    if (this._status !== 'idle' && this._status !== 'stopped') {
      return err(
        appError(
          'CLI_ALREADY_RUNNING',
          `Cannot start: process is in '${this._status}' state`,
        ),
      )
    }

    this._setStatus('starting')

    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
    ]

    if (options.model) {
      args.push('--model', options.model)
    }

    if (options.sessionId) {
      args.push('--resume', options.sessionId)
    }

    if (options.continueSession) {
      args.push('--continue')
    }

    if (options.maxTurns !== undefined) {
      args.push('--max-turns', String(options.maxTurns))
    }

    if (options.permissionMode === 'auto') {
      args.push('--allowedTools', 'all')
    } else if (options.permissionMode === 'bypassPermissions') {
      args.push('--dangerously-skip-permissions')
    }

    let child: ChildProcess
    try {
      child = spawn('claude', args, {
        cwd: options.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (cause) {
      this._setStatus('error')
      return err(appError('CLI_SPAWN_FAILED', 'Failed to spawn claude CLI', { cause }))
    }

    this._process = child
    this._parser = new StreamParser()
    this._store.add(this._parser)

    this._wireParserEvents(this._parser)
    this._wireProcessEvents(child, this._parser)

    const initialPrompt = JSON.stringify({ type: 'user', message: options.prompt })
    const writeResult = this._writeStdin(child, initialPrompt + '\n')
    if (!writeResult.ok) {
      this._setStatus('error')
      child.kill('SIGTERM')
      return writeResult
    }

    this._setStatus('running')
    return ok(undefined)
  }

  sendPrompt(message: string, images?: string[]): Result<void> {
    if (this._status !== 'running' && this._status !== 'waiting_permission') {
      return err(
        appError(
          'CLI_NOT_RUNNING',
          `Cannot send prompt: process is in '${this._status}' state`,
        ),
      )
    }
    if (!this._process) {
      return err(appError('CLI_NOT_RUNNING', 'Process not initialized'))
    }

    const payload: Record<string, unknown> = { type: 'user', message }
    if (images && images.length > 0) {
      payload['images'] = images
    }

    return this._writeStdin(this._process, JSON.stringify(payload) + '\n')
  }

  async cancel(): Promise<void> {
    if (this._status === 'stopped' || this._status === 'stopping') return
    if (!this._process) return

    this._setStatus('stopping')
    this._process.kill('SIGINT')

    await new Promise<void>((resolve) => {
      this._cancelTimer = setTimeout(() => {
        this._process?.kill('SIGTERM')
        resolve()
      }, 5000)

      this._process?.once('exit', () => {
        if (this._cancelTimer) {
          clearTimeout(this._cancelTimer)
          this._cancelTimer = null
        }
        resolve()
      })
    })
  }

  dispose(): void {
    if (this._cancelTimer) {
      clearTimeout(this._cancelTimer)
      this._cancelTimer = null
    }
    if (this._process) {
      this._process.kill('SIGTERM')
      this._process = null
    }
    this._store.dispose()
    this._listeners.clear()
    this._setStatus('stopped')
  }

  private _setStatus(status: CliProcessStatus): void {
    this._status = status
    this._emit('status_change', { status })
  }

  private _emit<E extends CliEventName>(event: E, data: CliProcessEvents[E]): void {
    const handlers = this._listeners.get(event)
    if (!handlers) return
    for (const h of handlers) {
      h(data)
    }
  }

  private _writeStdin(child: ChildProcess, data: string): Result<void> {
    if (!child.stdin || child.stdin.destroyed) {
      return err(appError('CLI_STDIN_CLOSED', 'stdin is not writable'))
    }
    try {
      child.stdin.write(data)
      return ok(undefined)
    } catch (cause) {
      return err(appError('CLI_STDIN_WRITE_FAILED', 'Failed to write to stdin', { cause }))
    }
  }

  private _wireParserEvents(parser: StreamParser): void {
    const forward = <E extends keyof StreamParserEvents>(event: E) => {
      const unsub = parser.on(event, (data) => {
        this._emit(event as CliEventName, data as CliProcessEvents[CliEventName])

        if (event === 'permission_request') {
          this._setStatus('waiting_permission')
        }
        if (event === 'turn_end') {
          this._setStatus('idle')
        }
        if (event === 'error') {
          this._setStatus('error')
        }
        if (event === 'rate_limit') {
          this._setStatus('error')
        }
      })
      this._store.add({ dispose: unsub })
    }

    forward('session_id')
    forward('init')
    forward('text_chunk')
    forward('text_delta')
    forward('stream_event')
    forward('tool_call')
    forward('tool_result')
    forward('permission_request')
    forward('turn_end')
    forward('error')
    forward('rate_limit')
    forward('rate_limit_info')
    forward('hook_event')
  }

  private _wireProcessEvents(child: ChildProcess, parser: StreamParser): void {
    if (child.stdout) {
      const rl = createInterface({ input: child.stdout, crlfDelay: Infinity })
      rl.on('line', (line) => parser.feed(line))
      this._store.add({ dispose: () => rl.close() })
    }

    if (child.stderr) {
      const rl = createInterface({ input: child.stderr, crlfDelay: Infinity })
      rl.on('line', (_line) => {
        // stderr logging — intentionally silent in production; can be wired to a logger
      })
      this._store.add({ dispose: () => rl.close() })
    }

    child.on('exit', (code) => {
      if (this._status !== 'stopped' && this._status !== 'error') {
        if (code === 0) {
          this._setStatus('stopped')
        } else {
          this._setStatus('error')
        }
      }
    })
  }
}
