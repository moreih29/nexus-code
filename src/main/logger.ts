import log from 'electron-log/main'
import { app } from 'electron'

// sandbox:true 환경에서 renderer 로깅 지원
// preload에서 직접 import 대신 main에서 IPC 브릿지 자동 주입
log.initialize()
import { join } from 'path'
import { createWriteStream, existsSync, mkdirSync, readdirSync, statSync, unlinkSync, WriteStream } from 'fs'

// 카테고리 타입 정의
export type LogCategory =
  | 'app'
  | 'ipc'
  | 'session'
  | 'cli'
  | 'stream'
  | 'hook'
  | 'permission'
  | 'agent'
  | 'plugin'
  | 'checkpoint'
  | 'settings'

// 구조화된 로그 인터페이스
interface StructuredLog {
  _structured: true
  ts: string
  level: string
  cat: LogCategory
  msg: string
  sessionId?: string
  workspace?: string
  [key: string]: unknown
}

// 세션 전용 카테고리 (항상 세션 파일로 라우팅)
const SESSION_CATEGORIES: Set<LogCategory> = new Set([
  'cli', 'stream', 'hook', 'permission', 'agent', 'checkpoint'
])
// ipc, session은 하이브리드 → sessionId 유무로 판단

// 세션 스트림 관리
const sessionStreams = new Map<string, WriteStream>()
let sessionsDir: string

function getOrCreateSessionStream(sessionId: string): WriteStream {
  let stream = sessionStreams.get(sessionId)
  if (!stream) {
    if (!sessionsDir) {
      sessionsDir = join(app.getPath('logs'), 'sessions')
      mkdirSync(sessionsDir, { recursive: true })
    }
    stream = createWriteStream(
      join(sessionsDir, `session-${sessionId}.log`),
      { flags: 'a' }
    )
    sessionStreams.set(sessionId, stream)
  }
  return stream
}

export function closeSessionStream(sessionId: string): void {
  const stream = sessionStreams.get(sessionId)
  if (stream) {
    stream.end()
    sessionStreams.delete(sessionId)
  }
}

const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000 // 30일
const MAX_FILES = 100

export function cleanupOldSessionLogs(): void {
  if (!sessionsDir) {
    sessionsDir = join(app.getPath('logs'), 'sessions')
  }
  try {
    if (!existsSync(sessionsDir)) return
    const files = readdirSync(sessionsDir)
      .map(f => ({ name: f, path: join(sessionsDir, f), mtime: statSync(join(sessionsDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)

    const now = Date.now()
    for (let i = 0; i < files.length; i++) {
      if (i >= MAX_FILES || now - files[i].mtime > MAX_AGE_MS) {
        unlinkSync(files[i].path)
      }
    }
  } catch {}
}

// app ready 이후에만 경로 설정 가능
app.whenReady().then(() => {
  log.transports.file.resolvePathFn = () =>
    join(app.getPath('logs'), 'main.log')
})

// 로테이션 설정
log.transports.file.maxSize = 10 * 1024 * 1024
log.transports.file.archiveLog = (oldLogPath) => {
  const { dir, name, ext } = require('path').parse(oldLogPath)
  const timestamp = Date.now()
  return join(dir, `${name}.${timestamp}${ext}`)
}

// JSON 구조화 포맷: raw text 모드
log.transports.file.format = '{text}'

// 파일 레벨
log.transports.file.level = 'debug'

// 콘솔 레벨: dev=debug, prod=warn, 환경변수로 오버라이드
const envLevel = process.env.NEXUS_LOG_LEVEL
if (envLevel) {
  log.transports.console.level = envLevel as typeof log.transports.console.level
} else {
  log.transports.console.level = import.meta.env.DEV ? 'debug' : 'warn'
}

// main.log에서 세션 메시지 필터링
log.hooks.push((message, _transport, transportName) => {
  if (transportName === 'file') {
    const text = message.data?.[0]
    if (typeof text === 'string') {
      try {
        const parsed = JSON.parse(text)
        if (parsed.sessionId && SESSION_CATEGORIES.has(parsed.cat)) {
          return false // main.log에 쓰지 않음
        }
        // 하이브리드 카테고리도 sessionId 있으면 필터
        if (parsed.sessionId && (parsed.cat === 'ipc' || parsed.cat === 'session')) {
          return false
        }
      } catch {}
    }
  }
  return message
})

// 카테고리 서브로거 팩토리
function createCategoryLogger(cat: LogCategory) {
  const scope = log.scope(cat)

  function makeEntry(
    level: string,
    msg: string,
    meta?: Record<string, unknown>
  ): string {
    const entry: StructuredLog = {
      _structured: true,
      ts: new Date().toISOString(),
      level,
      cat,
      msg,
      ...meta,
    }
    return JSON.stringify(entry)
  }

  function logAndRoute(level: 'debug' | 'info' | 'warn' | 'error', msg: string, meta?: Record<string, unknown>) {
    const entryStr = makeEntry(level, msg, meta)

    // electron-log로 출력 (콘솔 + main.log, hooks가 세션 메시지 필터)
    scope[level](entryStr)

    // 세션별 파일 라우팅
    const sessionId = meta?.sessionId as string | undefined
    if (sessionId && (SESSION_CATEGORIES.has(cat) || cat === 'ipc' || cat === 'session')) {
      getOrCreateSessionStream(sessionId).write(entryStr + '\n')
    }
  }

  return {
    debug(msg: string, meta?: Record<string, unknown>) {
      logAndRoute('debug', msg, meta)
    },
    info(msg: string, meta?: Record<string, unknown>) {
      logAndRoute('info', msg, meta)
    },
    warn(msg: string, meta?: Record<string, unknown>) {
      logAndRoute('warn', msg, meta)
    },
    error(msg: string, meta?: Record<string, unknown>) {
      logAndRoute('error', msg, meta)
    },
  }
}

// 11개 카테고리 서브로거 export
export const logger = {
  app: createCategoryLogger('app'),
  ipc: createCategoryLogger('ipc'),
  session: createCategoryLogger('session'),
  cli: createCategoryLogger('cli'),
  stream: createCategoryLogger('stream'),
  hook: createCategoryLogger('hook'),
  permission: createCategoryLogger('permission'),
  agent: createCategoryLogger('agent'),
  plugin: createCategoryLogger('plugin'),
  checkpoint: createCategoryLogger('checkpoint'),
  settings: createCategoryLogger('settings'),
}

// 하위 호환: 기존 import log from '../logger' 유지
export default log
