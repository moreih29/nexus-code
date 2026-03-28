import http from 'http'
import { randomUUID } from 'crypto'
import { EventEmitter } from 'events'
import { BrowserWindow } from 'electron'
import { IpcChannel } from '../../shared/ipc'
import type { PermissionRequestEvent } from '../../shared/types'
import { PermissionHandler } from './permission-handler'
import { savePermanentRule } from './approval-store'
import log from '../logger'

export interface HookServerOptions {
  permissionHandler: PermissionHandler
}

export interface PreToolUsePayload {
  sessionId: string
  toolName: string
  toolInput: Record<string, unknown>
  agentId?: string
  toolUseId: string
}

export declare interface HookServer {
  on(event: 'pre-tool-use', listener: (payload: PreToolUsePayload) => void): this
}

export class HookServer extends EventEmitter {
  private server: http.Server | null = null
  private readonly appSecret: string
  private runToken: string
  private readonly permissionHandler: PermissionHandler

  constructor(options: HookServerOptions) {
    super()
    this.appSecret = randomUUID()
    this.runToken = randomUUID()
    this.permissionHandler = options.permissionHandler
  }

  /** 새 실행마다 runToken을 갱신 */
  refreshRunToken(): string {
    this.runToken = randomUUID()
    return this.runToken
  }

  get currentRunToken(): string {
    return this.runToken
  }

  /** 서버가 리스닝 중인 포트 (시작 전이면 null) */
  get port(): number | null {
    if (!this.server) return null
    const addr = this.server.address()
    if (!addr || typeof addr === 'string') return null
    return addr.port
  }

  /** 현재 실행에 사용할 훅 URL (구 pre-tool-use 방식, 내부용) */
  hookUrl(sessionId: string): string {
    return `http://127.0.0.1:${this.port}/hook/pre-tool-use/${this.appSecret}/${this.runToken}?sessionId=${sessionId}`
  }

  /** PermissionRequest 훅용 URL */
  permissionHookUrl(): string {
    return `http://127.0.0.1:${this.port}/permission/${this.appSecret}/${this.runToken}`
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        this.handleRequest(req, res)
      })

      server.on('error', reject)

      // 포트 0 → OS가 빈 포트 자동 할당
      server.listen(0, '127.0.0.1', () => {
        this.server = server
        resolve()
      })
    })
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) {
        resolve()
        return
      }
      this.server.close(() => {
        this.server = null
        resolve()
      })
    })
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.port}`)
    const pathParts = url.pathname.split('/').filter(Boolean)

    if (req.method !== 'POST') {
      res.writeHead(404)
      res.end('Not Found')
      return
    }

    // POST /permission/<appSecret>/<runToken>
    if (pathParts.length === 3 && pathParts[0] === 'permission') {
      const [, reqAppSecret, reqRunToken] = pathParts
      if (reqAppSecret !== this.appSecret || reqRunToken !== this.runToken) {
        res.writeHead(401)
        res.end('Unauthorized')
        return
      }
      this.handlePermissionRequest(req, res)
      return
    }

    // POST /hook/pre-tool-use/<appSecret>/<runToken>
    if (
      pathParts.length >= 4 &&
      pathParts[0] === 'hook' &&
      pathParts[1] === 'pre-tool-use'
    ) {
      const [, , reqAppSecret, reqRunToken] = pathParts
      if (reqAppSecret !== this.appSecret || reqRunToken !== this.runToken) {
        res.writeHead(401)
        res.end('Unauthorized')
        return
      }
      const sessionId = url.searchParams.get('sessionId') ?? ''
      this.handlePreToolUse(req, res, sessionId)
      return
    }

    res.writeHead(404)
    res.end('Not Found')
  }

  private handlePermissionRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })

    req.on('end', async () => {
      try {
        // PreToolUse 훅 입력 포맷
        const payload = JSON.parse(body) as {
          hook_event_name?: string
          session_id?: string
          tool_name?: string
          tool_input?: Record<string, unknown>
          tool_use_id?: string
        }

        const toolName = payload.tool_name ?? ''
        const toolInput = payload.tool_input ?? {}
        const toolUseId = payload.tool_use_id ?? randomUUID()
        const sessionId = payload.session_id ?? ''

        log.info('[HookServer] PreToolUse:', toolName)

        // AgentTracker용 이벤트 emit
        this.emit('pre-tool-use', {
          sessionId,
          toolName,
          toolInput,
          agentId: undefined,
          toolUseId,
        } satisfies PreToolUsePayload)

        // 자동 승인 여부 먼저 확인
        if (this.permissionHandler.isAutoApproved(toolName, toolInput)) {
          log.info('[HookServer] auto-approved:', toolName)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({}))
          return
        }

        const requestId = randomUUID()
        const event: PermissionRequestEvent = {
          sessionId,
          requestId,
          toolName,
          input: toolInput,
          agentId: undefined,
        }

        log.info('[HookServer] awaiting permission (PreToolUse):', requestId, toolName)

        const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
        if (win) {
          win.webContents.send(IpcChannel.PERMISSION_REQUEST, event)
        }

        const { approved, scope } = await this.permissionHandler.waitForResponse(requestId)
        log.info('[HookServer] responded (PreToolUse):', requestId, approved ? 'allow' : 'deny', scope ?? 'once')

        if (approved && scope === 'session') {
          this.permissionHandler.addSessionRule(toolName)
        } else if (approved && scope === 'permanent') {
          this.permissionHandler.addPermanentRule(toolName)
          savePermanentRule(toolName).catch((err) =>
            log.warn('[HookServer] savePermanentRule failed:', err)
          )
        }

        if (approved) {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({}))
        } else {
          // HTTP 403 → curl --fail이 exit code non-zero 반환 → CLI가 도구 차단
          res.writeHead(403, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: '사용자 거부' }))
        }
      } catch {
        res.writeHead(403, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: '요청 파싱 실패' }))
      }
    })

    req.on('error', () => {
      res.writeHead(403, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: '서버 오류' }))
    })
  }

  private handlePreToolUse(req: http.IncomingMessage, res: http.ServerResponse, sessionId: string): void {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })

    req.on('end', async () => {
      try {
        const payload = JSON.parse(body) as {
          tool_name?: string
          tool_input?: Record<string, unknown>
          agent_id?: string
        }

        const toolName = payload.tool_name ?? ''
        const toolInput = payload.tool_input ?? {}
        const agentId = payload.agent_id
        const toolUseId = randomUUID()

        log.info('[HookServer] request:', toolName, 'agent:', agentId ?? 'main')

        // AgentTracker용 이벤트 emit (구독자가 없어도 안전)
        this.emit('pre-tool-use', {
          sessionId,
          toolName,
          toolInput,
          agentId,
          toolUseId,
        } satisfies PreToolUsePayload)

        // 자동 승인 여부 먼저 확인
        if (this.permissionHandler.isAutoApproved(toolName, toolInput)) {
          log.info('[HookServer] auto-approved:', toolName)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ decision: 'allow' }))
          return
        }

        // Renderer에 퍼미션 요청 이벤트 전송
        const requestId = randomUUID()
        const event: PermissionRequestEvent = {
          sessionId,
          requestId,
          toolName,
          input: toolInput,
          agentId
        }

        log.info('[HookServer] awaiting permission:', requestId, toolName)

        const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
        if (win) {
          win.webContents.send(IpcChannel.PERMISSION_REQUEST, event)
        }

        // Renderer 응답 대기 (60초 타임아웃)
        const { approved, scope } = await this.permissionHandler.waitForResponse(requestId)
        log.info('[HookServer] responded:', requestId, approved ? 'allow' : 'deny', scope ?? 'once')

        if (approved && scope === 'session') {
          this.permissionHandler.addSessionRule(toolName)
        } else if (approved && scope === 'permanent') {
          this.permissionHandler.addPermanentRule(toolName)
          savePermanentRule(toolName).catch((err) =>
            log.warn('[HookServer] savePermanentRule failed:', err)
          )
        }

        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ decision: approved ? 'allow' : 'deny' }))
      } catch {
        res.writeHead(400)
        res.end('Bad Request')
      }
    })

    req.on('error', () => {
      res.writeHead(500)
      res.end('Internal Server Error')
    })
  }
}
