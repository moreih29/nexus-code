import { appendFile, mkdir } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

type Level = 'info' | 'warn' | 'error'

function getLogPath(): string {
  const base = process.env.NEXUS_LOG_DIR ?? path.join(os.homedir(), '.nexus-code', 'logs')
  const date = new Date().toISOString().slice(0, 10)
  return path.join(base, '_system', `electron-main-${date}.log`)
}

let dirEnsured = false

async function ensureDir(filePath: string): Promise<void> {
  if (dirEnsured) return
  try {
    await mkdir(path.dirname(filePath), { recursive: true })
    dirEnsured = true
  } catch {
    // swallow — logging must never crash the process
  }
}

async function write(level: Level, message: string, data?: unknown): Promise<void> {
  try {
    const logPath = getLogPath()
    await ensureDir(logPath)
    const ts = new Date().toISOString()
    const suffix = data !== undefined ? ' ' + JSON.stringify(data) : ''
    const line = `${ts} [${level}] ${message}${suffix}\n`
    await appendFile(logPath, line, 'utf8')
  } catch {
    // swallow — logging failure must not crash the process
  }
}

export const logger = {
  info(message: string, data?: unknown): void {
    void write('info', message, data)
  },
  warn(message: string, data?: unknown): void {
    void write('warn', message, data)
  },
  error(message: string, data?: unknown): void {
    void write('error', message, data)
  },
  async flush(): Promise<void> {
    // append 패턴 사용으로 in-flight write 완료를 기다릴 필요 없음
    // best-effort: Node I/O queue drain을 위해 한 틱 양보
    await new Promise<void>((resolve) => setImmediate(resolve))
  },
}
