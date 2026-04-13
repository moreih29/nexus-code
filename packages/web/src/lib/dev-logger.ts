const IS_DEV = import.meta.env.DEV

const BASE_URL = import.meta.env.VITE_API_URL ?? ''

interface QueueEntry {
  level: 'log' | 'info' | 'warn' | 'error'
  source: string
  message: string
  data?: unknown
  ts: string
  requestId?: string
}

const queue: QueueEntry[] = []
let flushTimer: ReturnType<typeof setTimeout> | null = null
const FLUSH_INTERVAL_MS = 100
const MAX_BATCH = 50

// 현재 활성 workspace path — setDevLoggerWorkspacePath()로 외부에서 주입
let _currentWorkspacePath: string | null = null

export function setDevLoggerWorkspacePath(path: string | null): void {
  _currentWorkspacePath = path
}

function flush(useBeacon = false): void {
  if (!IS_DEV || queue.length === 0) return
  const batch = queue.splice(0, MAX_BATCH)
  const body = JSON.stringify({
    workspacePath: _currentWorkspacePath ?? undefined,
    entries: batch,
  })
  const url = `${BASE_URL}/api/dev/client-log`
  if (useBeacon && typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
    navigator.sendBeacon(url, body)
  } else {
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => {})
  }
}

function schedule(): void {
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    flush()
  }, FLUSH_INTERVAL_MS)
}

function enqueue(entry: QueueEntry): void {
  if (!IS_DEV) return
  queue.push(entry)
  if (queue.length >= MAX_BATCH) {
    flush()
  } else {
    schedule()
  }
}

export const devLogger = {
  log(source: string, message: string, data?: unknown): void {
    if (!IS_DEV) return
    enqueue({ level: 'log', source, message, data, ts: new Date().toISOString() })
  },
  info(source: string, message: string, data?: unknown): void {
    if (!IS_DEV) return
    enqueue({ level: 'info', source, message, data, ts: new Date().toISOString() })
  },
  warn(source: string, message: string, data?: unknown): void {
    if (!IS_DEV) return
    enqueue({ level: 'warn', source, message, data, ts: new Date().toISOString() })
  },
  error(source: string, message: string, data?: unknown): void {
    if (!IS_DEV) return
    // 에러는 즉시 flush
    queue.push({ level: 'error', source, message, data, ts: new Date().toISOString() })
    flush()
  },
}

if (IS_DEV && typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => flush(true))
  window.addEventListener('beforeunload', () => flush(true))
}
